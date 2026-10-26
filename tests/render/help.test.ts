import { expect, test } from 'vitest';

import type { Cell } from '../../src/render/frame.js';
import { HELP_LINES, drawHelp } from '../../src/render/help.js';

function blank(cols: number, rows: number): Cell[] {
  return Array.from({ length: cols * rows }, () => ({ ch: ' ', width: 1 as const, sgr: '' }));
}

function rowsText(cells: Cell[], cols: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += cols) {
    rows.push(
      cells
        .slice(i, i + cols)
        .map(c => c.ch)
        .join(''),
    );
  }
  return rows;
}

test('HELP_LINES is the exact help copy', () => {
  expect(HELP_LINES).toEqual([
    'blockterm keys',
    'ctrl+k        agent line / switch focus',
    '#             suggest a command (empty prompt)',
    'ctrl+↑ ctrl+↓ select a block',
    '  c o r e     copy command, copy output, rerun, explain',
    'wheel         scroll blocks, or agent replies under the pointer',
    'shift+PgUp/Dn scroll blocks',
    'shift+drag    select text; your terminal copies it',
    'ctrl+l        clear blocks (idle prompt)',
    'ctrl+l        clear agent chat (agent line)',
    'y / Enter     approve · e edit · n deny · a all',
    'F1 / Esc      close this help',
    "ctrl+k replaces readline's kill-line and vim's ctrl+k digraphs.",
  ]);
});

test('drawHelp at 80x24 draws a bordered box containing every line', () => {
  const cols = 80;
  const rows = 24;
  const cells = blank(cols, rows);
  drawHelp(cells, cols, rows);
  const text = rowsText(cells, cols).join('\n');
  for (const line of HELP_LINES) expect(text).toContain(line);
  expect(text).toContain('┌');
  expect(text).toContain('┐');
  expect(text).toContain('└');
  expect(text).toContain('┘');
});

test('drawHelp at 30x8 clips to fit the frame', () => {
  const cols = 30;
  const rows = 8;
  const cells = blank(cols, rows);
  drawHelp(cells, cols, rows);
  expect(cells).toHaveLength(cols * rows);
  const lines = rowsText(cells, cols);
  expect(lines).toHaveLength(rows);
  for (const line of lines) expect(line).toHaveLength(cols);
  const text = lines.join('\n');
  expect(text).toContain('blockterm keys');
  expect(text).not.toContain("ctrl+k replaces readline's kill-line and vim's ctrl+k digraphs.");
  expect(text).toContain('┌');
  expect(text).toContain('┘');
});
