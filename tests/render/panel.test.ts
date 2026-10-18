import { expect, test } from 'vitest';

import { displayTokens, parseKeys } from '../../src/agent/keys.js';
import { initialUi } from '../../src/focus.js';
import type { PanelUi } from '../../src/focus.js';
import type { Cell } from '../../src/render/frame.js';
import { drawPanel } from '../../src/render/panel.js';
import type { PanelView, Transcript } from '../../src/render/panel.js';

const FRAME_COLS = 40;
const RECT = { row: 1, col: 4, rows: 10, cols: 30 };
const INNER_COL = 5;
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
  expect(cs[(RECT.row + 1) * FRAME_COLS + INNER_COL + INNER_COLS]!.ch).toBe(' ');
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

test('returns the cursor after the input prompt when focused', () => {
  const cs = blank();
  const pos = drawPanel(cs, FRAME_COLS, RECT, ui({ input: 'hi' }), [], null);
  expect(pos).toEqual({ row: INPUT_ROW, col: INNER_COL + 4 });
  expect(rowText(cs, INPUT_ROW).slice(INNER_COL)).toContain('❯ hi');
});

test('returns no cursor when the terminal has focus', () => {
  const cs = blank();
  const pos = drawPanel(cs, FRAME_COLS, RECT, ui({ focus: 'terminal' }), [], null);
  expect(pos).toBeNull();
});
