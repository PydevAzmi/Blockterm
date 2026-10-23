import type { IBufferCell, Terminal } from '@xterm/headless';

import type { Layout } from '../layout.js';
import type { View } from '../term/session.js';
import { composeBlocks, type BlocksView } from './blocks.js';

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
}

export interface Chrome {
  title: string;
  footer: string;
  view: View;
  footerStatus?: string;
  blocks?: BlocksView;
  now?: number;
}

export const FOOTER = 'F1 help · ctrl+k agent · ctrl+l clear';

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
    cells[r * cols + c] = { ch, width, sgr };
  };

  const putText = (r: number, text: string): void => {
    for (let c = 0; c < cols; c += 1) {
      put(r, c, c < text.length ? text[c]! : ' ', 1, '');
    }
  };

  const framed = (open: string, content: string, close: string): string => {
    let line = open + content;
    const head = cols - 1;
    if (line.length > head) line = line.slice(0, head);
    else line = line.padEnd(head, '─');
    return line + close;
  };

  for (let i = 0; i < cells.length; i += 1) cells[i] = { ch: ' ', width: 1, sgr: '' };

  putText(0, framed('┌ ', `${chrome.title} `, '┐'));
  putText(rows - 2, framed('├', '', '┤'));
  const footer =
    chrome.footerStatus !== undefined && chrome.footerStatus !== ''
      ? `${chrome.footer}  ${chrome.footerStatus}`
      : chrome.footer;
  putText(rows - 1, framed('└ ', `${footer} `, '┘'));

  const active = mirror.buffer.active;
  const reCell = active.getNullCell();
  const side = chrome.view === 'blocks' ? '│' : ' ';
  const rightSide = layout.origin.col + layout.pty.cols;
  const rightBorder = rightSide + 1;
  const blocks =
    chrome.view === 'blocks' && chrome.blocks !== undefined && chrome.blocks.store.integrated
      ? composeBlocks(
          mirror,
          chrome.blocks,
          { cols: layout.pty.cols + 2, rows: layout.pty.rows },
          chrome.now ?? Date.now(),
        )
      : null;

  for (let r = 1; r <= rows - 3; r += 1) {
    put(r, 0, '│', 1, '');
    if (rightBorder < cols) put(r, rightBorder, '│', 1, '');
    put(r, 1, side, 1, '');
    if (rightSide > 1 && rightSide < cols) put(r, rightSide, side, 1, '');

    if (blocks !== null) {
      const blockRow = blocks.rows[r - 1];
      if (blockRow !== undefined) {
        const left = layout.origin.col - 1;
        for (let x = 0; x < blockRow.length && left + x < cols; x += 1) {
          const copied = blockRow[x]!;
          put(r, left + x, copied.ch, copied.width, copied.sgr);
        }
      }
      continue;
    }

    const i = r - 1;
    if (i >= layout.pty.rows) continue;
    const line = active.getLine(active.viewportY + i);
    if (!line) continue;

    for (let x = 0; x < layout.pty.cols; x += 1) {
      const c = 2 + x;
      if (c > cols - 3) break;
      const cell = line.getCell(x, reCell);
      if (!cell) continue;
      const copied = cellFrom(cell);
      put(r, c, copied.ch, copied.width, copied.sgr);
    }
  }

  let cursor = {
    row: layout.origin.row + active.cursorY,
    col: layout.origin.col + active.cursorX,
    visible:
      cursorVisible && active.viewportY === active.baseY && active.cursorX < layout.pty.cols,
  };

  if (blocks !== null) {
    if (blocks.cursor !== null) {
      cursor = {
        row: layout.origin.row + blocks.cursor.row,
        col: layout.origin.col - 1 + blocks.cursor.col,
        visible: cursorVisible,
      };
    } else {
      cursor = { ...cursor, visible: false };
    }
  }

  return { cols, rows, cells, cursor, blocksDocHeight: blocks?.docHeight };
}
