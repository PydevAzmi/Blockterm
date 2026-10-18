import type { IBufferCell, Terminal } from '@xterm/headless';

import type { Layout } from '../layout.js';
import type { View } from '../term/session.js';

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
}

export interface Chrome {
  title: string;
  footer: string;
  view: View;
  footerStatus?: string;
}

export const FOOTER = 'F1 help · ctrl+k agent · ctrl+l clear';

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

  for (let r = 1; r <= rows - 3; r += 1) {
    put(r, 0, '│', 1, '');
    if (rightBorder < cols) put(r, rightBorder, '│', 1, '');
    put(r, 1, side, 1, '');
    if (rightSide > 1 && rightSide < cols) put(r, rightSide, side, 1, '');

    const i = r - 1;
    if (i >= layout.pty.rows) continue;
    const line = active.getLine(active.viewportY + i);
    if (!line) continue;

    for (let x = 0; x < layout.pty.cols; x += 1) {
      const c = 2 + x;
      if (c > cols - 3) break;
      const cell = line.getCell(x, reCell);
      if (!cell) continue;
      const width = cell.getWidth();
      if (width === 0) {
        put(r, c, '', 0, buildSgr(cell));
      } else if (width === 2) {
        put(r, c, cell.getChars(), 2, buildSgr(cell));
      } else {
        const ch = cell.getChars();
        put(r, c, ch === '' ? ' ' : ch, 1, buildSgr(cell));
      }
    }
  }

  const cursor = {
    row: layout.origin.row + active.cursorY,
    col: layout.origin.col + active.cursorX,
    visible:
      cursorVisible && active.viewportY === active.baseY && active.cursorX < layout.pty.cols,
  };

  return { cols, rows, cells, cursor };
}
