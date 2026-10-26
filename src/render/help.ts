import type { Cell } from './frame.js';

export const HELP_LINES: readonly string[] = [
  'blockterm keys',
  'ctrl+k        agent line / switch focus',
  '#             suggest a command (empty prompt)',
  'ctrl+↑ ctrl+↓ select a block',
  '  c o r e     copy command, copy output, rerun, explain',
  'wheel         scroll blocks, or agent replies under the pointer',
  'shift+PgUp/Dn scroll blocks',
  'drag          select text in a pane; release copies',
  'ctrl+l        clear blocks (idle prompt)',
  'ctrl+l        clear agent chat (agent line)',
  'y / Enter     approve · e edit · n deny · a all',
  'F1 / Esc      close this help',
  "ctrl+k replaces readline's kill-line and vim's ctrl+k digraphs.",
];

export function drawHelp(cells: Cell[], cols: number, rows: number): void {
  if (cols <= 0 || rows <= 0) return;

  const put = (row: number, col: number, ch: string): void => {
    if (row < 0 || row >= rows || col < 0 || col >= cols) return;
    cells[row * cols + col] = { ch, width: 1, sgr: '' };
  };

  let widest = 0;
  for (const line of HELP_LINES) {
    const width = Array.from(line).length;
    if (width > widest) widest = width;
  }

  const boxCols = Math.min(cols, widest + 4);
  const boxRows = Math.min(rows, HELP_LINES.length + 2);
  const left = Math.floor((cols - boxCols) / 2);
  const top = Math.floor((rows - boxRows) / 2);
  const innerCols = Math.max(0, boxCols - 2);
  const innerRows = Math.max(0, boxRows - 2);

  for (let r = 0; r < boxRows; r += 1) {
    for (let c = 0; c < boxCols; c += 1) put(top + r, left + c, ' ');
  }

  for (let c = 0; c < boxCols; c += 1) {
    put(top, left + c, '─');
    put(top + boxRows - 1, left + c, '─');
  }
  for (let r = 0; r < boxRows; r += 1) {
    put(top + r, left, '│');
    put(top + r, left + boxCols - 1, '│');
  }
  put(top, left, '┌');
  put(top, left + boxCols - 1, '┐');
  put(top + boxRows - 1, left, '└');
  put(top + boxRows - 1, left + boxCols - 1, '┘');

  const contentWidth = Math.max(0, innerCols - 2);
  if (contentWidth === 0) return;

  const shown = Math.min(innerRows, HELP_LINES.length);
  for (let i = 0; i < shown; i += 1) {
    const chars = Array.from(HELP_LINES[i]!);
    for (let j = 0; j < chars.length && j < contentWidth; j += 1) {
      put(top + 1 + i, left + 2 + j, chars[j]!);
    }
  }
}
