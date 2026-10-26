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

const RTL_CHROME = { title: 'blockterm', footer: FOOTER, view: 'blocks' as const, rtl: true };

const thirtyLines = Array.from({ length: 30 }, (_, i) => `L${i}`).join('\r\n');

test('mirror text starts at the top-left corner with no frame', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, 'hi');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 0, 0).ch).toBe('h');
  expect(cell(f, 0, 1).ch).toBe('i');
});

test('no box drawing surrounds the terminal', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  for (let r = 0; r < f.rows; r += 1) expect(rowText(f, r)).not.toMatch(/[┌┐└┘├┤│]/);
});

test('the mode line names the shell in parentheses, with hints on the right', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '');
  const f = composeFrame(m, layout, { mode: 'pwsh', title: '~/proj', footer: 'F1 help', view: 'blocks' }, true);
  const last = rowText(f, f.rows - 1);
  expect(last.startsWith('(pwsh) ~/proj')).toBe(true);
  expect(last.endsWith('F1 help')).toBe(true);
  expect(cell(f, f.rows - 1, 0).sgr).toBe('1');
  expect(cell(f, f.rows - 1, 7).sgr).toBe('2');
});

test('a status replaces the hints and stands out', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '');
  const f = composeFrame(m, layout, { mode: 'bash', title: '~', footer: 'F1 help', footerStatus: 'agent busy', view: 'blocks' }, true);
  const last = rowText(f, f.rows - 1);
  expect(last.endsWith('agent busy')).toBe(true);
  expect(last).not.toContain('F1 help');
  expect(cell(f, f.rows - 1, f.cols - 1).sgr).toBe('33');
});

test('palette foreground', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '\x1b[31mR');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 0, 0).sgr).toBe('31');
});

test('bold truecolor foreground', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '\x1b[1;38;2;1;2;3mX');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 0, 0).sgr).toBe('1;38;2;1;2;3');
});

test('256-colour foreground', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '\x1b[38;5;200mY');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 0, 0).sgr).toBe('38;5;200');
});

test('palette background', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '\x1b[44mZ');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 0, 0).sgr).toBe('44');
});

test('wide characters take two cells', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '世');
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(cell(f, 0, 0).width).toBe(2);
  expect(cell(f, 0, 1).width).toBe(0);
});

test('cursor follows the mirror', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, 'hi');
  const shown = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(shown.cursor).toEqual({ row: 0, col: 2, visible: true });
  const hidden = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, false);
  expect(hidden.cursor.visible).toBe(false);
});

test('Arabic shell output is shaped and drawn right to left', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, 'echo مرحبا\r\nمرحبا');
  const f = composeFrame(m, layout, RTL_CHROME, true);
  expect(rowText(f, 1).slice(0, 5)).toBe('ﺎﺒﺣﺮﻣ');
  expect(f.logical?.get(1)?.cells.map(c => c.ch).join('').slice(0, 5)).toBe('مرحبا');
});

test('Arabic shell output in the alt screen is untouched', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '\x1b[?1049hمرحبا');
  const f = composeFrame(m, layout, { ...RTL_CHROME, view: 'fullscreen' }, true);
  expect(rowText(f, 0).slice(0, 5)).toBe('مرحبا');
  expect(f.logical?.size ?? 0).toBe(0);
});

test('rtl off or missing leaves the shell row untouched', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, 'مرحبا');
  const off = composeFrame(m, layout, { ...RTL_CHROME, rtl: false }, true);
  expect(rowText(off, 0).slice(0, 5)).toBe('مرحبا');
  expect(off.logical?.size ?? 0).toBe(0);

  const missing = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(rowText(missing, 0).slice(0, 5)).toBe('مرحبا');
});

test('the shell cursor follows the reordered character', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, 'مر');
  const atEnd = composeFrame(m, layout, RTL_CHROME, true);
  expect(atEnd.cursor.col).toBe(2);
  expect(rowText(atEnd, 0).slice(0, 2)).toBe('ﺮﻣ');

  await write(m, '\x1b[D');
  const back = composeFrame(m, layout, RTL_CHROME, true);
  expect(back.cursor.col).toBe(0);
});

test('shell rows under rtl keep leading indentation in place', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, '    مرحبا');
  const f = composeFrame(m, layout, RTL_CHROME, true);
  expect(rowText(f, 0).slice(0, 4)).toBe('    ');
  expect(rowText(f, 0).slice(4, 9)).toBe('ﺎﺒﺣﺮﻣ');
});

test('shell rows under rtl keep columns of paths, numbers and trailing words', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, 'مرحبا.txt   12:00   ملف');
  const f = composeFrame(m, layout, RTL_CHROME, true);
  expect(rowText(f, 0).slice(0, 5)).toBe('ﺎﺒﺣﺮﻣ');
  expect(rowText(f, 0).slice(5, 9)).toBe('.txt');
  expect(rowText(f, 0).slice(12, 17)).toBe('12:00');
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
  expect(rowText(f, 8).slice(0, 3)).toBe('L29');
  expect(rowText(f, 0).slice(0, 3)).toBe('L21');
});

test('hides cursor when scrolled back', async () => {
  const m = await mirror(layout.pty.cols, layout.pty.rows, thirtyLines);
  m.scrollLines(-5);
  const f = composeFrame(m, layout, { title: 'blockterm', footer: FOOTER, view: 'blocks' }, true);
  expect(f.cursor.visible).toBe(false);
  expect(rowText(f, 0).slice(0, 3)).toBe('L16');
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
