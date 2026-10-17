import { expect, test } from 'vitest';

import xterm from '@xterm/headless';
import type { Terminal } from '@xterm/headless';

import { computeLayout } from '../../src/layout.js';
import { composeFrame, FOOTER, type Frame } from '../../src/render/frame.js';

const { Terminal } = xterm;

const layout = computeLayout({ cols: 40, rows: 10 });

function write(t: Terminal, data: string): Promise<void> {
  return new Promise(resolve => t.write(data, () => resolve()));
}

async function mirror(cols: number, rows: number, data: string): Promise<Terminal> {
  const t = new Terminal({ cols, rows, allowProposedApi: true });
  await write(t, data);
  return t;
}

function cell(f: Frame, row: number, col: number) {
  return f.cells[row * f.cols + col];
}

function rowText(f: Frame, row: number): string {
  return f.cells
    .slice(row * f.cols, (row + 1) * f.cols)
    .map(c => c.ch)
    .join('');
}

const thirtyLines = Array.from({ length: 30 }, (_, i) => `L${i}`).join('\r\n');

test('mirror text lands inside the borders', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, 'hi');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 1, 2).ch).toBe('h');
  expect(cell(f, 1, 3).ch).toBe('i');
});

test('frame corners', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 0, 0).ch).toBe('┌');
  expect(cell(f, 0, 39).ch).toBe('┐');
  expect(cell(f, 8, 0).ch).toBe('├');
  expect(cell(f, 9, 0).ch).toBe('└');
});

test('borders depend on the view', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '');
  const blocks = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  const full = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'fullscreen' }, true);
  expect(cell(blocks, 1, 1).ch).toBe('│');
  expect(cell(full, 1, 1).ch).toBe(' ');
});

test('palette foreground', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '\x1b[31mR');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 1, 2).sgr).toBe('31');
});

test('bold truecolor foreground', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '\x1b[1;38;2;1;2;3mX');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 1, 2).sgr).toBe('1;38;2;1;2;3');
});

test('256-colour foreground', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '\x1b[38;5;200mY');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 1, 2).sgr).toBe('38;5;200');
});

test('palette background', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '\x1b[44mZ');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 1, 2).sgr).toBe('44');
});

test('wide characters take two cells', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '世');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 1, 2).width).toBe(2);
  expect(cell(f, 1, 3).width).toBe(0);
});

test('cursor follows the mirror', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, 'hi');
  const shown = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(shown.cursor).toEqual({ row: 1, col: 4, visible: true });
  const hidden = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, false);
  expect(hidden.cursor.visible).toBe(false);
});

test('footer sits on the last row', async () => {
  const big = computeLayout({ cols: 60, rows: 12 });
  const m = await mirror(big.pty.cols, big.pty.rows, '');
  const f = composeFrame(m, big, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  const row11 = f.cells
    .slice((big.host.rows - 1) * f.cols, big.host.rows * f.cols)
    .map(c => c.ch)
    .join('');
  expect(row11).toContain(FOOTER);
});

test('shows the bottom of a scrolled buffer', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, thirtyLines);
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(rowText(f, 7).slice(2, 5)).toBe('L29');
  expect(rowText(f, 1).slice(2, 5)).toBe('L23');
});

test('hides cursor when scrolled back', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, thirtyLines);
  m.scrollLines(-5);
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(f.cursor.visible).toBe(false);
  expect(rowText(f, 1).slice(2, 5)).toBe('L18');
});

test('tiny host stays rectangular', async () => {
  const tiny = computeLayout({ cols: 10, rows: 4 });
  const m = await mirror(tiny.pty.cols, tiny.pty.rows, '');
  const f = composeFrame(m, tiny, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(f.rows).toBe(4);
  expect(f.cells).toHaveLength(40);
  for (let r = 0; r < tiny.host.rows; r += 1) {
    expect(f.cells.slice(r * f.cols, (r + 1) * f.cols)).toHaveLength(tiny.host.cols);
  }
});
