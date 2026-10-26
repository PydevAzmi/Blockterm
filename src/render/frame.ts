import type { IBufferCell, Terminal } from '@xterm/headless';

import type { Layout } from '../layout.js';
import type { View } from '../term/session.js';
import { composeBlocks, type BlockRow, type BlocksView } from './blocks.js';
import { reorderSpan, visualCol, type LogicalRow } from './rtl.js';

export interface Cell {
  ch: string;
  width: 0 | 1 | 2;
  sgr: string;
}

export interface Frame {
  cols: number;
  rows: number;
  cells: Cell[];
  cursor: { row: number; col: number; visible: boolean };
  blocksDocHeight?: number;
  blockRows?: BlockRow[];
  logical?: Map<number, LogicalRow>;
}

export interface Chrome {
  mode?: string;
  title: string;
  footer: string;
  view: View;
  footerStatus?: string;
  blocks?: BlocksView;
  now?: number;
  rtl?: boolean;
}

export const FOOTER = 'F1 help · ctrl+k agent';
const MODE_SGR = '1';
const DIM_SGR = '2';
const STATUS_SGR = '33';

export function cellFrom(cell: IBufferCell): Cell {
  const width = cell.getWidth();
  const chars = cell.getChars();
  if (width === 0) return { ch: '', width: 0, sgr: buildSgr(cell) };
  if (width === 2) return { ch: chars, width: 2, sgr: buildSgr(cell) };
  return { ch: chars === '' ? ' ' : chars, width: 1, sgr: buildSgr(cell) };
}

function buildSgr(cell: IBufferCell): string {
  const parts: string[] = [];

  if (cell.isBold()) parts.push('1');
  if (cell.isDim()) parts.push('2');
  if (cell.isItalic()) parts.push('3');
  if (cell.isUnderline()) parts.push('4');
  if (cell.isBlink()) parts.push('5');
  if (cell.isInverse()) parts.push('7');
  if (cell.isInvisible()) parts.push('8');
  if (cell.isStrikethrough()) parts.push('9');
  if (cell.isOverline()) parts.push('53');

  if (cell.isFgPalette()) {
    const n = cell.getFgColor();
    if (n < 8) parts.push(`3${n}`);
    else if (n < 16) parts.push(`9${n - 8}`);
    else parts.push(`38;5;${n}`);
  } else if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    parts.push(`38;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
  }

  if (cell.isBgPalette()) {
    const n = cell.getBgColor();
    if (n < 8) parts.push(`4${n}`);
    else if (n < 16) parts.push(`10${n - 8}`);
    else parts.push(`48;5;${n}`);
  } else if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    parts.push(`48;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
  }

  return parts.join(';');
}

export function composeFrame(
  mirror: Terminal,
  layout: Layout,
  chrome: Chrome,
  cursorVisible: boolean,
): Frame {
  const { cols, rows } = layout.host;
  const cells: Cell[] = new Array<Cell>(cols * rows);

  const put = (r: number, c: number, ch: string, width: 0 | 1 | 2, sgr: string): void => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    cells[r * cols + c] = { ch, width, sgr };
  };

  const putRun = (r: number, c: number, text: string, sgr: string): number => {
    let x = c;
    for (const ch of Array.from(text)) {
      if (x >= cols) break;
      put(r, x, ch, 1, sgr);
      x += 1;
    }
    return x;
  };

  for (let i = 0; i < cells.length; i += 1) cells[i] = { ch: ' ', width: 1, sgr: '' };

  // Mode line: "(pwsh) ~/proj (main) · model" on the left, hints or status on the right.
  const status = chrome.footerStatus ?? '';
  const right = status !== '' ? status : chrome.footer;
  const rightWidth = Array.from(right).length;
  let x = 0;
  if (chrome.mode !== undefined && chrome.mode !== '') x = putRun(rows - 1, x, `(${chrome.mode}) `, MODE_SGR);
  const room = Math.max(0, cols - x - (rightWidth > 0 ? rightWidth + 2 : 0));
  // Too long: keep the end (folder tail, branch, model), elide the start.
  const title = Array.from(chrome.title);
  const shown = title.length <= room ? title : room > 0 ? ['…', ...title.slice(title.length - room + 1)] : [];
  putRun(rows - 1, x, shown.join(''), DIM_SGR);
  if (rightWidth > 0 && rightWidth + 1 < cols) {
    putRun(rows - 1, cols - rightWidth, right, status !== '' ? STATUS_SGR : DIM_SGR);
  }

  const active = mirror.buffer.active;
  const reCell = active.getNullCell();
  const top = layout.origin.row;
  const left = layout.origin.col;
  const reorder = chrome.rtl === true && chrome.view === 'blocks';
  const logical = new Map<number, LogicalRow>();
  const blocks =
    chrome.view === 'blocks' && chrome.blocks !== undefined && chrome.blocks.store.integrated
      ? composeBlocks(mirror, chrome.blocks, layout.pty, chrome.now ?? Date.now())
      : null;

  for (let i = 0; i < layout.pty.rows; i += 1) {
    const r = top + i;
    if (blocks !== null) {
      const blockRow = blocks.rows[i];
      if (blockRow === undefined) continue;
      for (let c = 0; c < blockRow.length && left + c < cols; c += 1) {
        const copied = blockRow[c]!;
        put(r, left + c, copied.ch, copied.width, copied.sgr);
      }
      if (reorder) reorderSpan(cells, cols, r, left, layout.pty.cols, 'ltr', logical);
      continue;
    }

    const line = active.getLine(active.viewportY + i);
    if (!line) continue;
    for (let c = 0; c < layout.pty.cols && left + c < cols; c += 1) {
      const cell = line.getCell(c, reCell);
      if (!cell) continue;
      const copied = cellFrom(cell);
      put(r, left + c, copied.ch, copied.width, copied.sgr);
    }
    if (reorder) reorderSpan(cells, cols, r, left, layout.pty.cols, 'ltr', logical);
  }

  let cursor = {
    row: top + active.cursorY,
    col: left + active.cursorX,
    visible:
      cursorVisible && active.viewportY === active.baseY && active.cursorX < layout.pty.cols,
  };

  if (blocks !== null) {
    cursor =
      blocks.cursor !== null
        ? { row: top + blocks.cursor.row, col: left + blocks.cursor.col, visible: cursorVisible }
        : { ...cursor, visible: false };
  }

  const logicalCursor = logical.get(cursor.row);
  if (logicalCursor !== undefined) {
    cursor = { ...cursor, col: visualCol(logicalCursor.map, cursor.col, cursor.col) };
  }

  return {
    cols,
    rows,
    cells,
    cursor,
    blocksDocHeight: blocks?.docHeight,
    blockRows: blocks?.blockRows,
    logical,
  };
}
