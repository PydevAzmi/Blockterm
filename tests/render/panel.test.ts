import { expect, test } from 'vitest';

import { displayTokens, parseKeys } from '../../src/agent/keys.js';
import { initialUi } from '../../src/focus.js';
import type { PanelUi } from '../../src/focus.js';
import type { Cell } from '../../src/render/frame.js';
import { drawPanel } from '../../src/render/panel.js';
import type { PanelView, Transcript } from '../../src/render/panel.js';

const FRAME_COLS = 40;
const RECT = { row: 2, col: 0, rows: 10, cols: 40 };
const INPUT_ROW = RECT.row + RECT.rows - 1;

function blank(): Cell[] {
  return Array.from({ length: FRAME_COLS * 12 }, () => ({ ch: ' ', width: 1 as const, sgr: '' }));
}

function rowText(cs: Cell[], row: number): string {
  return cs
    .slice(row * FRAME_COLS, (row + 1) * FRAME_COLS)
    .map(c => c.ch)
    .join('');
}

function cellAt(cs: Cell[], row: number, col: number): Cell {
  return cs[row * FRAME_COLS + col]!;
}

function ui(over: Partial<PanelView> = {}): PanelView {
  const base: PanelUi = { ...initialUi(), open: true, focus: 'panel' };
  return { ...base, ...over };
}

test('the input line names the mode and model in parentheses', () => {
  const cs = blank();
  drawPanel(cs, FRAME_COLS, RECT, ui({ model: 'deepseek-v4.1-flash' }), [], null);
  expect(rowText(cs, INPUT_ROW).startsWith('(agent · deepseek-v4.1-flash) ❯ ')).toBe(true);
});

test('without a model the input line says (agent)', () => {
  const cs = blank();
  drawPanel(cs, FRAME_COLS, RECT, ui(), [], null);
  expect(rowText(cs, INPUT_ROW).startsWith('(agent) ❯ ')).toBe(true);
});

test('the model label is escaped', () => {
  const cs = blank();
  drawPanel(cs, FRAME_COLS, RECT, ui({ model: 'a\x1bb' }), [], null);
  expect(rowText(cs, INPUT_ROW)).toContain('(agent · a\\x1bb)');
  expect(cs.map(c => c.ch)).not.toContain('\x1b');
});

test('the label takes the agent color when focused and dims when not', () => {
  const focused = blank();
  drawPanel(focused, FRAME_COLS, RECT, ui({ color: '35' }), [], null);
  expect(cellAt(focused, INPUT_ROW, 0).sgr).toBe('1;35');

  const idle = blank();
  drawPanel(idle, FRAME_COLS, RECT, ui({ focus: 'terminal', color: '35' }), [], null);
  expect(cellAt(idle, INPUT_ROW, 0).sgr).toBe('2');
});

test('agent replies use the configured color, with no "agent:" prefix', () => {
  const cs = blank();
  drawPanel(cs, FRAME_COLS, RECT, ui({ color: '38;5;141' }), [{ who: 'agent', text: 'done' }], null);
  const row = INPUT_ROW - 1;
  expect(rowText(cs, row).trimEnd()).toBe('done');
  expect(cellAt(cs, row, 0).sgr).toBe('38;5;141');
});

test('agent replies default to cyan', () => {
  const cs = blank();
  drawPanel(cs, FRAME_COLS, RECT, ui(), [{ who: 'agent', text: 'ok' }], null);
  expect(cellAt(cs, INPUT_ROW - 1, 0).sgr).toBe('36');
});

test('the transcript sits right above the input line, newest last, roles styled', () => {
  const cs = blank();
  const transcript: Transcript[] = [
    { who: 'you', text: 'why' },
    { who: 'tool', text: 'read_screen' },
    { who: 'agent', text: 'because\n\nreasons' },
    { who: 'error', text: 'boom' },
  ];
  drawPanel(cs, FRAME_COLS, RECT, ui(), transcript, null);
  const lines = [5, 4, 3, 2, 1].map(n => rowText(cs, INPUT_ROW - n).trimEnd());
  expect(lines).toEqual(['❯ why', '· read_screen', 'because', 'reasons', 'boom']);
  expect(cellAt(cs, INPUT_ROW - 1, 0).sgr).toBe('31');
  expect(cellAt(cs, INPUT_ROW - 5, 0).sgr).toBe('2');
});

test('a long transcript line wraps across the full width', () => {
  const cs = blank();
  drawPanel(cs, FRAME_COLS, RECT, ui(), [{ who: 'agent', text: 'x'.repeat(60) }], null);
  expect(rowText(cs, INPUT_ROW - 2)).toBe('x'.repeat(40));
  expect(rowText(cs, INPUT_ROW - 1).trimEnd()).toBe('x'.repeat(20));
});

test('scroll shows older transcript lines and is clamped to what exists', () => {
  const transcript: Transcript[] = Array.from({ length: 20 }, (_, i) => ({ who: 'agent', text: `line ${i}` }));
  const cs = blank();
  const result = drawPanel(cs, FRAME_COLS, RECT, ui({ scroll: 5 }), transcript, null);
  expect(result.scroll).toBe(5);
  expect(rowText(cs, INPUT_ROW - 1).trimEnd()).toBe('line 14');

  const top = drawPanel(blank(), FRAME_COLS, RECT, ui({ scroll: 999 }), transcript, null);
  expect(top.scroll).toBe(20 - (RECT.rows - 1));
});

test('the panel draws no box characters', () => {
  const cs = blank();
  drawPanel(cs, FRAME_COLS, RECT, ui({ model: 'm' }), [{ who: 'agent', text: 'hi' }], null);
  for (let r = RECT.row; r < RECT.row + RECT.rows; r += 1) {
    expect(rowText(cs, r)).not.toMatch(/[┌┐└┘├┤│]/);
  }
});

test('a status sits at the right end of the input line', () => {
  const cs = blank();
  drawPanel(cs, FRAME_COLS, RECT, ui({ status: 'agent busy' }), [], null);
  expect(rowText(cs, INPUT_ROW).endsWith('agent busy')).toBe(true);
  expect(cellAt(cs, INPUT_ROW, FRAME_COLS - 1).sgr).toBe('33');
});

test('the approval card is amber and shows key labels', () => {
  const cs = blank();
  const parsed = parseKeys('echo hi<Enter>');
  const tokens = parsed.ok ? displayTokens(parsed.tokens) : [];
  drawPanel(cs, FRAME_COLS, RECT, ui({ model: 'm' }), [], { target: 'shell', tokens });
  expect(cs.map(c => c.sgr).join(' ')).toContain('38;5;178');
  const text = Array.from({ length: RECT.rows }, (_, i) => rowText(cs, RECT.row + i)).join('\n');
  expect(text).toContain('Type into shell');
  expect(text).toContain('⏎ Enter');
  expect(text).toContain('y approve  e edit  n deny  a');
  expect(text).toContain('task');
});

test('a long card payload wraps across rows without dropping characters', () => {
  const cs = blank();
  const rect = { row: 1, col: 2, rows: 10, cols: 36 };
  const parsed = parseKeys('git commit -am "a fairly long commit message here"<Enter>');
  const tokens = parsed.ok ? displayTokens(parsed.tokens) : [];
  drawPanel(cs, FRAME_COLS, rect, ui({ model: 'm' }), [], { target: 'shell', tokens });
  const all = Array.from({ length: rect.rows }, (_, i) =>
    rowText(cs, rect.row + i).slice(rect.col, rect.col + rect.cols),
  ).join('');
  expect(all).toContain('git commit -am "a fairly long commit message here"');
  expect(all).toContain('⏎ Enter');
});

test('an oversized card is reported truncated and shows the edit/deny hint', () => {
  const cs = blank();
  const rect = { row: 1, col: 2, rows: 5, cols: 36 };
  const parsed = parseKeys('git commit -am "a very long commit message that will not fit"<Enter>');
  const tokens = parsed.ok ? displayTokens(parsed.tokens) : [];
  const result = drawPanel(cs, FRAME_COLS, rect, ui({ model: 'm' }), [], { target: 'shell', tokens });
  expect(result.cardTruncated).toBe(true);
  const all = Array.from({ length: rect.rows }, (_, i) =>
    rowText(cs, rect.row + i).slice(rect.col, rect.col + rect.cols),
  ).join('');
  expect(all).toContain('too long to show — e to edit, n to deny, or widen the window');
});

test('transcript control characters are escaped, not written raw', () => {
  const cs = blank();
  drawPanel(cs, FRAME_COLS, RECT, ui({ model: 'm' }), [
    { who: 'agent', text: 'a\x1b]52;c;ZXZpbA==\x07b' },
  ], null);
  const chars = cs.map(c => c.ch);
  expect(chars).not.toContain('\x1b');
  expect(chars).not.toContain('\x07');
  expect(chars.join('')).toContain('\\x1b');
});

test('input and card target control characters are escaped', () => {
  const cs = blank();
  const parsed = parseKeys('x');
  const tokens = parsed.ok ? displayTokens(parsed.tokens) : [];
  drawPanel(cs, FRAME_COLS, RECT, ui({ model: 'm', input: 'a\x1bb' }), [], {
    target: 'sh\x07ell',
    tokens,
  });
  const chars = cs.map(c => c.ch);
  expect(chars).not.toContain('\x1b');
  expect(chars).not.toContain('\x07');
  expect(chars.join('')).toContain('\\x1b');
  expect(chars.join('')).toContain('\\x07');
});

test('a wrapped input is drawn across rows without dropping characters', () => {
  const cs = blank();
  const rect = { row: 1, col: 2, rows: 10, cols: 16 };
  const result = drawPanel(cs, FRAME_COLS, rect, ui({ input: 'abcdefghijklmnopqrstuvwxyz' }), [], null);
  expect(result.inputTruncated).toBe(false);
  const all = Array.from({ length: rect.rows }, (_, i) =>
    rowText(cs, rect.row + i).slice(rect.col + 10, rect.col + rect.cols),
  ).join('');
  expect(all.replace(/ /g, '')).toBe('abcdefghijklmnopqrstuvwxyz');
});

test('an input too long for the panel is reported truncated', () => {
  const cs = blank();
  const rect = { row: 1, col: 2, rows: 5, cols: 36 };
  const result = drawPanel(cs, FRAME_COLS, rect, ui({ input: 'x'.repeat(300) }), [], null);
  expect(result.inputTruncated).toBe(true);
});

test('an input that fits is not truncated', () => {
  const cs = blank();
  const result = drawPanel(cs, FRAME_COLS, RECT, ui({ input: 'hello' }), [], null);
  expect(result.inputTruncated).toBe(false);
});

test('returns the cursor after the input when focused', () => {
  const cs = blank();
  const result = drawPanel(cs, FRAME_COLS, RECT, ui({ input: 'hi' }), [], null);
  expect(result.cursor).toEqual({ row: INPUT_ROW, col: '(agent) ❯ hi'.length });
  expect(rowText(cs, INPUT_ROW)).toContain('(agent) ❯ hi');
});

test('returns no cursor when the terminal has focus', () => {
  const cs = blank();
  const result = drawPanel(cs, FRAME_COLS, RECT, ui({ focus: 'terminal' }), [], null);
  expect(result.cursor).toBeNull();
});

test('the cursor sits at ui.cursor, after a wide character', () => {
  const cs = blank();
  const r = drawPanel(cs, FRAME_COLS, RECT, ui({ input: '世ab', cursor: 1 }), [], null);
  const promptWidth = '(agent) ❯ '.length;
  expect(r.cursor).toEqual({ row: INPUT_ROW, col: promptWidth + 2 });
});

test('cursor at the start of a long wrapped input stays on a visible row', () => {
  const cs = blank();
  const r = drawPanel(cs, FRAME_COLS, RECT, ui({ input: 'x'.repeat(500), cursor: 0 }), [], null);
  expect(r.cursor!.row).toBeGreaterThanOrEqual(RECT.row);
  expect(r.cursor!.row).toBeLessThanOrEqual(INPUT_ROW);
});
