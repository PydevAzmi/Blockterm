import { escapeControl } from '../agent/keys.js';
import type { PanelUi } from '../focus.js';
import type { Rect } from '../layout.js';
import type { Cell } from './frame.js';

export interface Transcript {
  who: 'you' | 'agent' | 'tool' | 'error' | 'note';
  text: string;
}

export interface PanelView extends PanelUi {
  model?: string;
  /** SGR for agent replies (config `agentColor`). */
  color?: string;
  /** Right-aligned note on the input line (approval pending, busy, ...). */
  status?: string;
  /** Transcript lines scrolled up from the newest. */
  scroll?: number;
}

export interface CardView {
  target: string;
  tokens: { kind: 'text' | 'key'; label: string }[];
}

const AMBER = '38;5;178';
const AMBER_REVERSE = `${AMBER};7`;
const DIM = '2';
const ERROR = '31';
const DEFAULT_COLOR = '36';
const CARD_ACTIONS = 'y approve  e edit  n deny  a allow for this task';
const CARD_NOTICE = 'too long to show — e to edit, n to deny, or widen the window';

export interface PanelDrawResult {
  cursor: { row: number; col: number } | null;
  cardTruncated: boolean;
  inputTruncated: boolean;
  /** The transcript scroll actually used, clamped to what exists. */
  scroll: number;
}

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
): PanelDrawResult {
  const totalRows = Math.floor(cells.length / frameCols);

  const put = (row: number, col: number, ch: string, width: 0 | 1 | 2, sgr: string): void => {
    if (row < 0 || row >= totalRows || col < 0 || col >= frameCols) return;
    cells[row * frameCols + col] = { ch, width, sgr };
  };

  const innerCol = rect.col;
  const innerCols = Math.max(0, rect.cols);
  const color = ui.color ?? DEFAULT_COLOR;
  const focused = ui.focus === 'panel';

  for (let r = 0; r < rect.rows; r += 1) {
    for (let c = 0; c < rect.cols; c += 1) put(rect.row + r, rect.col + c, ' ', 1, '');
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

  interface CardCell {
    ch: string;
    width: 0 | 1 | 2;
    sgr: string;
  }

  const cellsFor = (text: string, sgr: string): CardCell[][] => {
    const rows: CardCell[][] = [[]];
    let used = 0;
    for (const ch of Array.from(text)) {
      const w = charWidth(ch);
      if (used + w > innerCols && used > 0) {
        rows.push([]);
        used = 0;
      }
      const row = rows[rows.length - 1]!;
      row.push({ ch, width: w, sgr });
      if (w === 2) row.push({ ch: '', width: 0, sgr });
      used += w;
    }
    return rows;
  };

  const drawCells = (row: number, col: number, rowCells: CardCell[]): void => {
    let x = col;
    for (const cell of rowCells) {
      if (cell.width === 0) continue;
      if (x - col + cell.width > innerCols) break;
      put(row, x, cell.ch, cell.width, cell.sgr);
      if (cell.width === 2) put(row, x + 1, '', 0, cell.sgr);
      x += cell.width;
    }
  };

  // The input line names the mode in parentheses: "(agent · model) ❯ ".
  const label =
    ui.model !== undefined && ui.model !== '' ? `(agent · ${escapeControl(ui.model)})` : '(agent)';
  const prompt = `${label} ❯ `;
  const inputRow = rect.row + rect.rows - 1;
  const promptWidth = Math.min(
    Array.from(prompt).reduce((sum, ch) => sum + charWidth(ch), 0),
    Math.max(0, innerCols - 1),
  );
  const inputWrapWidth = Math.max(1, innerCols - promptWidth);
  const allInputLines = wrapLine(escapeControl(ui.input), inputWrapWidth);
  const maxInputRows = Math.max(1, rect.rows);
  const inputTruncated = allInputLines.length > maxInputRows;
  const inputLines = inputTruncated
    ? allInputLines.slice(allInputLines.length - maxInputRows)
    : allInputLines;
  const inputTop = inputRow - (inputLines.length - 1);
  const contentEnd = inputTop - 1;

  let cardRows: CardCell[][] = [];
  if (card !== null) {
    cardRows = cellsFor(`Type into ${escapeControl(card.target)}`, AMBER);
    const payload: CardCell[][] = [[]];
    let used = 0;
    for (const token of card.tokens) {
      if (used > 0) {
        if (used + 1 > innerCols) {
          payload.push([]);
          used = 0;
        }
        const sep = payload[payload.length - 1]!;
        sep.push({ ch: ' ', width: 1, sgr: AMBER });
        used += 1;
      }
      const text = token.kind === 'text' ? `"${token.label}"` : token.label;
      const sgr = token.kind === 'key' ? AMBER_REVERSE : AMBER;
      for (const ch of Array.from(text)) {
        const w = charWidth(ch);
        if (used + w > innerCols && used > 0) {
          payload.push([]);
          used = 0;
        }
        const row = payload[payload.length - 1]!;
        row.push({ ch, width: w, sgr });
        if (w === 2) row.push({ ch: '', width: 0, sgr });
        used += w;
      }
    }
    cardRows.push(...payload);
    for (const line of wrapLine(CARD_ACTIONS, innerCols)) cardRows.push(...cellsFor(line, AMBER));
  }

  const cardBudget = Math.max(0, contentEnd - rect.row + 1);
  const cardTruncated = card !== null && cardRows.length > cardBudget;
  let cardShown = cardRows;
  if (cardTruncated) {
    const notice = wrapLine(CARD_NOTICE, innerCols).flatMap(line => cellsFor(line, AMBER));
    cardShown = [cardRows[0]!, ...notice].slice(0, cardBudget);
  }
  const cardHeight = card !== null ? cardShown.length : 0;

  const available = Math.max(0, contentEnd + 1 - cardHeight - rect.row);

  const lines: { text: string; sgr: string }[] = [];
  for (const entry of transcript) {
    const [lead, sgr] =
      entry.who === 'you'
        ? ['❯ ', DIM]
        : entry.who === 'tool'
          ? ['· ', DIM]
          : entry.who === 'note'
            ? ['', DIM]
            : entry.who === 'error'
              ? ['', ERROR]
              : ['', color];
    for (const segment of `${lead}${entry.text}`.split('\n')) {
      if (entry.who === 'agent' && segment.trim() === '') continue;
      for (const text of wrapLine(escapeControl(segment), innerCols)) lines.push({ text, sgr });
    }
  }
  const scroll = Math.min(Math.max(0, ui.scroll ?? 0), Math.max(0, lines.length - available));
  const shown = lines.slice(Math.max(0, lines.length - available - scroll), lines.length - scroll);
  const transcriptTop = contentEnd + 1 - cardHeight - shown.length;
  for (let i = 0; i < shown.length; i += 1) {
    writeRun(transcriptTop + i, innerCol, shown[i]!.text, shown[i]!.sgr, innerCols);
  }

  if (card !== null) {
    let row = contentEnd + 1 - cardHeight;
    for (const rowCells of cardShown) {
      drawCells(row, innerCol, rowCells);
      row += 1;
    }
  }

  let endX = innerCol + promptWidth;
  const labelSgr = focused ? `1;${color}` : DIM;
  for (let i = 0; i < inputLines.length; i += 1) {
    const row = inputTop + i;
    const x = i === 0 ? writeRun(row, innerCol, prompt, labelSgr, promptWidth) : innerCol + promptWidth;
    endX = writeRun(row, x, inputLines[i]!, '', innerCols - promptWidth);
  }

  const status = ui.status ?? '';
  const statusWidth = Array.from(status).length;
  if (statusWidth > 0 && endX + 2 + statusWidth <= innerCol + innerCols) {
    writeRun(inputRow, innerCol + innerCols - statusWidth, status, '33', statusWidth);
  }

  const cursor = focused ? { row: inputRow, col: endX } : null;
  return { cursor, cardTruncated, inputTruncated, scroll };
}
