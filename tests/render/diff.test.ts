import { expect, test } from 'vitest';

import { renderDiff } from '../../src/render/diff.js';
import type { Cell, Frame } from '../../src/render/frame.js';

const PREFIX = '\x1b[?2026h\x1b[?25l';
const SUFFIX = '\x1b[?2026l';

function cell(ch: string, width: 0 | 1 | 2 = 1, sgr = ''): Cell {
  return { ch, width, sgr };
}

function frame(cols: number, rows: number, fill = ' '): Frame {
  return {
    cols,
    rows,
    cells: Array.from({ length: cols * rows }, () => cell(fill)),
    cursor: { row: 0, col: 0, visible: true },
  };
}

test('nothing changed renders nothing', () => {
  const f = frame(4, 2);
  expect(renderDiff(f, f)).toBe('');
});

test('a single changed cell is written in place', () => {
  const prev = frame(4, 2);
  const next = frame(4, 2);
  next.cells[1 * 4 + 2] = cell('X');
  const out = renderDiff(prev, next);
  expect(out).toContain('\x1b[2;3H');
  expect(out).toContain('X');
  expect(out.length).toBeLessThan(60);
});

test('full draw frames and moves to every row', () => {
  const next = frame(3, 2);
  const out = renderDiff(null, next);
  expect(out.startsWith(PREFIX)).toBe(true);
  expect(out).toContain('\x1b[1;1H');
  expect(out).toContain('\x1b[2;1H');
});

test('a style change emits its SGR before the character', () => {
  const prev = frame(2, 1);
  const next = frame(2, 1);
  next.cells[0] = cell('R', 1, '31');
  const out = renderDiff(prev, next);
  expect(out).toContain('\x1b[0;31mR');
});

test('cursor-only change emits just the framing and cursor suffix', () => {
  const prev = frame(2, 2);
  const next = frame(2, 2);
  next.cursor = { row: 1, col: 1, visible: true };
  const out = renderDiff(prev, next);
  expect(out).toBe(`${PREFIX}\x1b[2;2H\x1b[?25h${SUFFIX}`);
});

test('visible cursor ends with a move, show, and sync close', () => {
  const prev = frame(6, 2);
  const next = frame(6, 2);
  next.cursor = { row: 1, col: 4, visible: true };
  const out = renderDiff(prev, next);
  expect(out.endsWith('\x1b[2;5H\x1b[?25h\x1b[?2026l')).toBe(true);
});

test('hidden cursor adds no move or show', () => {
  const prev = frame(6, 2);
  const next = frame(6, 2);
  next.cursor = { row: 1, col: 4, visible: false };
  const out = renderDiff(prev, next);
  expect(out.endsWith(SUFFIX)).toBe(true);
  expect(out).not.toContain('?25h');
});

test('width-0 cells are never written, their owner is redrawn', () => {
  const prev = frame(2, 1);
  prev.cells[0] = cell('世', 2);
  prev.cells[1] = cell('', 0);
  const next = frame(2, 1);
  next.cells[0] = cell('世', 2);
  next.cells[1] = cell('Z', 0);
  const out = renderDiff(prev, next);
  expect(out).toContain('世');
  expect(out).not.toContain('Z');
});

test('a changed wide cell skips its width-0 follower', () => {
  const prev = frame(3, 1);
  prev.cells[0] = cell('A');
  prev.cells[1] = cell('b');
  prev.cells[2] = cell('c');
  const next = frame(3, 1);
  next.cells[0] = cell('世', 2);
  next.cells[1] = cell('', 0);
  const out = renderDiff(prev, next);
  expect(out).toContain('世');
  expect(out).not.toContain('b');
});

test('a different size is treated as a full redraw', () => {
  const prev = frame(2, 2);
  const next = frame(3, 2);
  const out = renderDiff(prev, next);
  expect(out.startsWith(PREFIX)).toBe(true);
  expect(out).toContain('\x1b[1;1H');
  expect(out).toContain('\x1b[2;1H');
});
