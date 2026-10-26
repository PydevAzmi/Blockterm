import { expect, test } from 'vitest';

import type { Frame, Cell } from '../src/render/frame.js';
import { computeLayout } from '../src/layout.js';
import { extendSelection, highlight, paneAt, selectedText, startSelection } from '../src/mouse-select.js';

function charWidth(ch: string): 1 | 2 {
  const cp = ch.codePointAt(0)!;
  return cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
    ? 2
    : 1;
}

function frameOf(lines: string[]): Frame {
  const cols = Math.max(1, ...lines.map(line => Array.from(line).reduce((n, ch) => n + charWidth(ch), 0)));
  const rows = lines.length;
  const cells: Cell[] = Array.from({ length: cols * rows }, () => ({ ch: ' ', width: 1, sgr: '' }));

  lines.forEach((line, row) => {
    let col = 0;
    for (const ch of Array.from(line)) {
      if (col >= cols) break;
      const width = charWidth(ch);
      cells[row * cols + col] = { ch, width, sgr: '' };
      if (width === 2 && col + 1 < cols) cells[row * cols + col + 1] = { ch: '', width: 0, sgr: '' };
      col += width;
    }
  });

  return { cols, rows, cells, cursor: { row: 0, col: 0, visible: false } };
}

test('paneAt splits shell, agent and the closed-panel footer row', () => {
  const open = computeLayout({ cols: 10, rows: 12 }, true);
  expect(paneAt(open, 0)).toBe('shell');
  expect(paneAt(open, open.pty.rows)).toBe('agent');
  expect(paneAt(open, 11)).toBe('agent');
  const closed = computeLayout({ cols: 10, rows: 6 });
  expect(paneAt(closed, 5)).toBeNull();
});

test('multi-row selection trims trailing spaces and joins rows with \\n', () => {
  const f = frameOf(['hello     ', 'world  x  ']);
  const sel = { pane: 'shell', anchor: { row: 0, col: 2 }, head: { row: 1, col: 7 }, moved: true } as const;
  expect(selectedText(f, sel)).toBe('llo\nworld  x');
});

test('backwards drag gives the same text', () => {
  const f = frameOf(['hello     ', 'world     ']);
  const sel = { pane: 'shell', anchor: { row: 1, col: 4 }, head: { row: 0, col: 1 }, moved: true } as const;
  expect(selectedText(f, sel)).toBe('ello\nworld');
});

test('starting or ending on a wide char half copies it once', () => {
  const f = frameOf(['a世b       ']); // cells: a, 世, '', b
  expect(selectedText(f, { pane: 'shell', anchor: { row: 0, col: 2 }, head: { row: 0, col: 3 }, moved: true })).toBe('世b');
  expect(selectedText(f, { pane: 'shell', anchor: { row: 0, col: 0 }, head: { row: 0, col: 1 }, moved: true })).toBe('a世');
});

test('extendSelection clamps to the starting pane and the right edge', () => {
  const layout = computeLayout({ cols: 10, rows: 12 }, true);
  const sel = startSelection(layout, { row: 1, col: 1 })!;
  const out = extendSelection(sel, layout, { row: 11, col: 40 });
  expect(out.head).toEqual({ row: layout.pty.rows - 1, col: 9 });
  expect(out.moved).toBe(true);
});

test('startSelection on the closed-panel footer row is null', () => {
  expect(startSelection(computeLayout({ cols: 10, rows: 6 }), { row: 5, col: 0 })).toBeNull();
});

test('highlight reverses only the selected cells', () => {
  const f = frameOf(['abcdef    ']);
  f.cells[1]!.sgr = '31';
  highlight(f, { pane: 'shell', anchor: { row: 0, col: 1 }, head: { row: 0, col: 2 }, moved: true });
  expect(f.cells.slice(0, 4).map(c => c.sgr)).toEqual(['', '31;7', '7', '']);
});
