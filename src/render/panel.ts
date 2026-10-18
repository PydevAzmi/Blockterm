import type { PanelUi } from '../focus.js';
import type { Rect } from '../layout.js';
import type { Cell } from './frame.js';

export interface Transcript {
  who: 'you' | 'agent' | 'tool' | 'error' | 'note';
  text: string;
}

export interface PanelView extends PanelUi {
  model?: string;
}

export interface CardView {
  target: string;
  tokens: { kind: 'text' | 'key'; label: string }[];
}

const AMBER = '38;5;178';
const AMBER_REVERSE = `${AMBER};7`;
const PROMPT = '❯ ';
const CARD_ACTIONS = 'y approve  e edit  n deny  a allow for this task';

function charWidth(ch: string): 1 | 2 {
  const code = ch.codePointAt(0)!;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function wrapLine(text: string, width: number): string[] {
  if (width <= 0) return [''];
  const lines: string[] = [];
  let current = '';
  let used = 0;
  for (const ch of Array.from(text)) {
    const w = charWidth(ch);
    if (used + w > width && current !== '') {
      lines.push(current);
      current = '';
      used = 0;
    }
    current += ch;
    used += w;
  }
  lines.push(current);
  return lines;
}

export function drawPanel(
  cells: Cell[],
  frameCols: number,
  rect: Rect,
  ui: PanelView,
  transcript: Transcript[],
  card: CardView | null,
): { row: number; col: number } | null {
  const totalRows = Math.floor(cells.length / frameCols);

  const put = (row: number, col: number, ch: string, width: 0 | 1 | 2, sgr: string): void => {
    if (row < 0 || row >= totalRows || col < 0 || col >= frameCols) return;
    cells[row * frameCols + col] = { ch, width, sgr };
  };

  const docked = rect.col > 1;
  const innerCol = docked ? rect.col + 1 : rect.col;
  const innerCols = Math.max(0, docked ? rect.cols - 1 : rect.cols);

  for (let r = 0; r < rect.rows; r += 1) {
    const row = rect.row + r;
    for (let c = 0; c < rect.cols; c += 1) put(row, rect.col + c, ' ', 1, '');
    if (docked) put(row, rect.col, '│', 1, '');
  }

  const writeRun = (row: number, col: number, text: string, sgr: string, max: number): number => {
    let x = col;
    for (const ch of Array.from(text)) {
      const w = charWidth(ch);
      if (x - col + w > max) break;
      put(row, x, ch, w, sgr);
      if (w === 2) put(row, x + 1, '', 0, sgr);
      x += w;
    }
    return x;
  };

  const title = ui.model !== undefined && ui.model !== '' ? `agent · ${ui.model}` : 'agent';
  writeRun(rect.row, innerCol, title, '', innerCols);

  const inputRow = rect.row + rect.rows - 1;
  const actionLines = card !== null ? wrapLine(CARD_ACTIONS, innerCols) : [];
  const cardHeight = card !== null ? 2 + actionLines.length : 0;
  const transcriptTop = rect.row + 1;
  const available = Math.max(0, inputRow - cardHeight - transcriptTop);

  const lines: string[] = [];
  for (const entry of transcript) {
    for (const segment of `${entry.who}: ${entry.text}`.split('\n')) {
      lines.push(...wrapLine(segment, innerCols));
    }
  }
  const shown = lines.slice(Math.max(0, lines.length - available));
  for (let i = 0; i < shown.length; i += 1) {
    writeRun(transcriptTop + i, innerCol, shown[i]!, '', innerCols);
  }

  if (card !== null) {
    const cardTop = inputRow - cardHeight;
    writeRun(cardTop, innerCol, `Type into ${card.target}`, AMBER, innerCols);
    let x = innerCol;
    const payloadRow = cardTop + 1;
    for (const token of card.tokens) {
      const remaining = (): number => innerCols - (x - innerCol);
      const text = token.kind === 'text' ? `"${token.label}"` : token.label;
      x = writeRun(payloadRow, x, text, token.kind === 'key' ? AMBER_REVERSE : AMBER, remaining());
      x = writeRun(payloadRow, x, ' ', AMBER, remaining());
    }
    for (let i = 0; i < actionLines.length; i += 1) {
      writeRun(cardTop + 2 + i, innerCol, actionLines[i]!, AMBER, innerCols);
    }
  }

  const inputX = writeRun(inputRow, innerCol, PROMPT, '', innerCols);
  const endX = writeRun(inputRow, inputX, ui.input, '', innerCols - (inputX - innerCol));

  if (ui.focus === 'panel') return { row: inputRow, col: endX };
  return null;
}
