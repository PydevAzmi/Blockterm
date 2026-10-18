import { expect, test } from 'vitest';

import xterm from '@xterm/headless';

import { displayTokens, parseKeys } from '../../src/agent/keys.js';
import { initialUi } from '../../src/focus.js';
import type { PanelUi } from '../../src/focus.js';
import { computeLayout } from '../../src/layout.js';
import type { Cell } from '../../src/render/frame.js';
import { FOOTER, composeFrame } from '../../src/render/frame.js';
import { drawPanel } from '../../src/render/panel.js';
import type { PanelView, Transcript } from '../../src/render/panel.js';

const { Terminal } = xterm;

const FRAME_COLS = 40;
const RECT = { row: 1, col: 4, rows: 10, cols: 30 };
const INNER_COL = 4;
const INNER_COLS = 29;
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

function ui(over: Partial<PanelView> = {}): PanelView {
  const base: PanelUi = { ...initialUi(), open: true, focus: 'panel' };
  return { ...base, ...over };
}

test('the title row shows the agent and model label', () => {
  const cs = blank();
  const transcript: Transcript[] = [
    { who: 'you', text: 'why' },
    { who: 'agent', text: 'long text' },
  ];
  drawPanel(cs, FRAME_COLS, RECT, ui({ model: 'claude-haiku-5-5' }), transcript, null);
  const title = rowText(cs, RECT.row).slice(INNER_COL);
  expect(title).toContain('agent · claude-haiku-5-5');
});

test('a long transcript line wraps within the inner width', () => {
  const cs = blank();
  const long = 'x'.repeat(60);
  drawPanel(cs, FRAME_COLS, RECT, ui({ model: 'm' }), [{ who: 'agent', text: long }], null);
  const first = rowText(cs, RECT.row + 1).slice(INNER_COL, INNER_COL + INNER_COLS);
  expect(first).toBe('agent: ' + 'x'.repeat(INNER_COLS - 'agent: '.length));
  const second = rowText(cs, RECT.row + 2).slice(INNER_COL, INNER_COL + INNER_COLS);
  expect(second).toBe('x'.repeat(INNER_COLS));
  expect(cs[(RECT.row + 1) * FRAME_COLS + INNER_COL + INNER_COLS]!.ch).toBe('│');
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
  expect(text).toContain('allow for this task');
});

test('a long card payload wraps across rows without dropping characters', () => {
  const cs = blank();
  const rect = { row: 1, col: 2, rows: 10, cols: 36 };
  const parsed = parseKeys('git commit -am "a fairly long commit message here"<Enter>');
  const tokens = parsed.ok ? displayTokens(parsed.tokens) : [];
  drawPanel(cs, FRAME_COLS, rect, ui({ model: 'm' }), [], { target: 'shell', tokens });
  const inner = rect.col;
  const all = Array.from({ length: rect.rows }, (_, i) =>
    rowText(cs, rect.row + i).slice(inner, inner + rect.cols - 1),
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
    rowText(cs, rect.row + i).slice(rect.col, rect.col + rect.cols - 1),
  ).join('');
  expect(all).toContain('too long to show — e to edit, n to deny, or widen the window');
});

test('the docked seam has a single border and keeps the outer border', () => {
  const layout = computeLayout({ cols: 200, rows: 50 }, true);
  expect(layout.panel.mode).toBe('docked');
  const rect = layout.panel.rect!;
  const mirror = new Terminal({
    cols: layout.pty.cols,
    rows: layout.pty.rows,
    allowProposedApi: true,
  });
  const frame = composeFrame(
    mirror,
    layout,
    { title: 'blockterm', footer: FOOTER, view: 'fullscreen' },
    true,
  );
  drawPanel(frame.cells, frame.cols, rect, ui({ model: 'm' }), [], null);
  const row = 5;
  const text = frame.cells
    .slice(row * frame.cols, (row + 1) * frame.cols)
    .map(c => c.ch)
    .join('');
  const seam = text.slice(layout.origin.col + layout.pty.cols, rect.col + 1);
  expect((seam.match(/│/g) ?? []).length).toBe(1);
  expect(text[frame.cols - 1]).toBe('│');
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

test('returns the cursor after the input prompt when focused', () => {
  const cs = blank();
  const result = drawPanel(cs, FRAME_COLS, RECT, ui({ input: 'hi' }), [], null);
  expect(result.cursor).toEqual({ row: INPUT_ROW, col: INNER_COL + 4 });
  expect(rowText(cs, INPUT_ROW).slice(INNER_COL)).toContain('❯ hi');
});

test('returns no cursor when the terminal has focus', () => {
  const cs = blank();
  const result = drawPanel(cs, FRAME_COLS, RECT, ui({ focus: 'terminal' }), [], null);
  expect(result.cursor).toBeNull();
});
