import type { Layout } from './layout.js';
import type { Frame } from './render/frame.js';

export type Pane = 'shell' | 'agent';

export interface Point {
  row: number;
  col: number;
}

export interface MouseSelection {
  pane: Pane;
  anchor: Point;
  head: Point;
  moved: boolean;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Pane under a host row: shell = rows 0..pty.rows-1, agent = all of panel.rect; else null. */
export function paneAt(layout: Layout, row: number): Pane | null {
  if (row >= 0 && row < layout.pty.rows) return 'shell';
  const rect = layout.panel.rect;
  if (rect !== null && row >= rect.row && row < rect.row + rect.rows) return 'agent';
  return null;
}

function paneRows(layout: Layout, pane: Pane): { first: number; last: number } {
  if (pane === 'shell') return { first: 0, last: layout.pty.rows - 1 };
  const rect = layout.panel.rect;
  if (rect === null) return { first: 0, last: layout.pty.rows - 1 };
  return { first: rect.row, last: rect.row + rect.rows - 1 };
}

function clampPoint(layout: Layout, pane: Pane, at: Point): Point {
  const { first, last } = paneRows(layout, pane);
  return {
    row: clamp(at.row, first, last),
    col: clamp(at.col, 0, layout.host.cols - 1),
  };
}

function ordered(sel: MouseSelection): { start: Point; end: Point } {
  const { anchor, head } = sel;
  if (anchor.row < head.row || (anchor.row === head.row && anchor.col <= head.col)) {
    return { start: anchor, end: head };
  }
  return { start: head, end: anchor };
}

/** Widen the start left past a width-0 cell and the end onto the continuation of a wide cell. */
function rowSpan(frame: Frame, row: number, startCol: number, endCol: number): { from: number; to: number } {
  const index = (col: number): number => row * frame.cols + col;
  let from = clamp(startCol, 0, frame.cols - 1);
  let to = clamp(endCol, 0, frame.cols - 1);

  while (from > 0 && frame.cells[index(from)]?.width === 0) from -= 1;
  if (frame.cells[index(to)]?.width === 2 && to + 1 < frame.cols) to += 1;

  return { from, to };
}

export function startSelection(layout: Layout, at: Point): MouseSelection | null {
  const pane = paneAt(layout, at.row);
  if (pane === null) return null;
  const point = clampPoint(layout, pane, at);
  return { pane, anchor: point, head: { ...point }, moved: false };
}

/** Clamps `at` into the selection's pane (rows) and 0..host.cols-1; sets moved when head changes. */
export function extendSelection(sel: MouseSelection, layout: Layout, at: Point): MouseSelection {
  const head = clampPoint(layout, sel.pane, at);
  const moved = sel.moved || head.row !== sel.head.row || head.col !== sel.head.col;
  return { pane: sel.pane, anchor: sel.anchor, head, moved };
}

/** Stream selection anchor..head inclusive in reading order; whole middle rows. */
export function selectedText(frame: Frame, sel: MouseSelection): string {
  const { start, end } = ordered(sel);
  const lines: string[] = [];

  for (let row = start.row; row <= end.row; row += 1) {
    if (row < 0 || row >= frame.rows) continue;
    const startCol = row === start.row ? start.col : 0;
    const endCol = row === end.row ? end.col : frame.cols - 1;
    const { from, to } = rowSpan(frame, row, startCol, endCol);

    let text = '';
    for (let col = from; col <= to; col += 1) {
      const cell = frame.cells[row * frame.cols + col];
      if (cell === undefined || cell.width === 0) continue;
      text += cell.ch;
    }
    lines.push(text.replace(/ +$/, ''));
  }

  return lines.join('\n');
}

/** Mutates frame.cells in range: sgr '' -> '7', else `${sgr};7`. */
export function highlight(frame: Frame, sel: MouseSelection): void {
  const { start, end } = ordered(sel);

  for (let row = start.row; row <= end.row; row += 1) {
    if (row < 0 || row >= frame.rows) continue;
    const startCol = row === start.row ? start.col : 0;
    const endCol = row === end.row ? end.col : frame.cols - 1;
    const { from, to } = rowSpan(frame, row, startCol, endCol);

    for (let col = from; col <= to; col += 1) {
      const cell = frame.cells[row * frame.cols + col];
      if (cell === undefined) continue;
      cell.sgr = cell.sgr === '' ? '7' : `${cell.sgr};7`;
    }
  }
}
