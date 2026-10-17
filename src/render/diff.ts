import type { Cell, Frame } from './frame.js';

const OPEN = '\x1b[?2026h\x1b[?25l';
const CLOSE = '\x1b[?2026l';

function move(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`;
}

function style(sgr: string): string {
  return sgr === '' ? '\x1b[0m' : `\x1b[0;${sgr}m`;
}

function cellEquals(a: Cell, b: Cell): boolean {
  return a.ch === b.ch && a.width === b.width && a.sgr === b.sgr;
}

function frameEquals(a: Frame, b: Frame): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

export function renderDiff(prev: Frame | null, next: Frame): string {
  const base = prev !== null && frameEquals(prev, next) ? prev : null;

  const cursorSame =
    base !== null &&
    base.cursor.row === next.cursor.row &&
    base.cursor.col === next.cursor.col &&
    base.cursor.visible === next.cursor.visible;

  const count = next.cells.length;
  const write = new Array<boolean>(count).fill(false);

  for (let i = 0; i < count; i += 1) {
    const cell = next.cells[i]!;
    const changed = base === null || !cellEquals(base.cells[i]!, cell);
    if (!changed) continue;
    if (cell.width === 0) {
      if (i > 0) write[i - 1] = true;
    } else {
      write[i] = true;
    }
  }

  let wroteAny = false;
  for (let i = 0; i < count; i += 1) {
    if (write[i]) {
      wroteAny = true;
      break;
    }
  }

  if (!wroteAny && cursorSame) return '';

  const parts: string[] = [OPEN];
  let cursorRow = -1;
  let cursorCol = -1;
  let currentStyle: string | null = null;

  for (let i = 0; i < count; i += 1) {
    if (!write[i]) continue;
    const row = Math.floor(i / next.cols);
    const col = i % next.cols;
    const cell = next.cells[i]!;

    if (row !== cursorRow || col !== cursorCol) parts.push(move(row, col));
    if (cell.sgr !== currentStyle) {
      parts.push(style(cell.sgr));
      currentStyle = cell.sgr;
    }
    parts.push(cell.ch);
    cursorRow = row;
    cursorCol = col + cell.width;
  }

  if (wroteAny) parts.push('\x1b[0m');

  if (next.cursor.visible) {
    parts.push(move(next.cursor.row, next.cursor.col));
    parts.push('\x1b[?25h');
  }
  parts.push(CLOSE);

  return parts.join('');
}
