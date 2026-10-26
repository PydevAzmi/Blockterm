import { expect, test } from 'vitest';

import { initialUi, reduce } from '../src/focus.js';
import type { PanelUi } from '../src/focus.js';
import type { InputEvent } from '../src/input/tokenize.js';

const bytes = (data: string): InputEvent => ({ type: 'bytes', data });

const panel = (over: Partial<PanelUi> = {}): PanelUi => ({
  ...initialUi(),
  open: true,
  focus: 'panel',
  ...over,
});

const withCard = (over: Partial<PanelUi> = {}): PanelUi => ({
  ...panel(over),
  card: { keys: 'rm -rf\r', target: 'shell', editing: false, denying: false },
});

const truncatedCard = (): PanelUi => ({
  ...panel(),
  card: { keys: 'rm -rf\r', target: 'shell', editing: false, denying: false, truncated: true },
});

const keysIn = (ui: PanelUi, ...seq: string[]): PanelUi =>
  seq.reduce((u, s) => reduce(u, bytes(s)).ui, ui);

test('agent-key opens the panel and reports a layout change', () => {
  const r = reduce(initialUi(), { type: 'agent-key' });
  expect(r.ui.open).toBe(true);
  expect(r.ui.focus).toBe('panel');
  expect(r.actions).toEqual([{ type: 'layout-changed' }]);
});

test('agent-key returns focus to the terminal, keeping the panel open', () => {
  const opened = reduce(initialUi(), { type: 'agent-key' }).ui;
  const r = reduce(opened, { type: 'agent-key' });
  expect(r.ui.open).toBe(true);
  expect(r.ui.focus).toBe('terminal');
  expect(r.actions).toEqual([]);
});

test('bytes with terminal focus go to the pty', () => {
  const event = bytes('ls\r');
  const r = reduce(initialUi(), event);
  expect(r.actions).toEqual([{ type: 'to-pty', event }]);
});

test('typing inserts into the panel input and backspace deletes', () => {
  const typed = reduce(panel(), bytes('hi')).ui;
  expect(typed.input).toBe('hi');
  const erased = reduce(typed, bytes('\x7f')).ui;
  expect(erased.input).toBe('h');
});

test('enter submits, marks busy and clears the input', () => {
  const r = reduce(panel({ input: 'hi' }), bytes('\r'));
  expect(r.actions).toEqual([{ type: 'submit', text: 'hi' }]);
  expect(r.ui.mode).toBe('busy');
  expect(r.ui.input).toBe('');
});

test('whitespace-only submit does nothing', () => {
  const r = reduce(panel({ input: '   ' }), bytes('\r'));
  expect(r.actions).toEqual([]);
  expect(r.ui.mode).toBe('idle');
  expect(r.ui.input).toBe('   ');
});

test('submit while busy does nothing and keeps the input', () => {
  const r = reduce(panel({ input: 'hi', mode: 'busy' }), bytes('\r'));
  expect(r.actions).toEqual([]);
  expect(r.ui.mode).toBe('busy');
  expect(r.ui.input).toBe('hi');
});

test('a paste event inserts its text into the input', () => {
  const r = reduce(panel({ input: 'ab' }), { type: 'paste', text: 'cd' });
  expect(r.ui.input).toBe('abcd');
  expect(r.actions).toEqual([]);
});

test('left arrow then typing inserts before the end', () => {
  const ui = keysIn(panel({ input: 'ac' }), '\x1b[D', 'b');
  expect(ui.input).toBe('abc');
  expect(ui.cursor).toBe(2);
});

test('application-cursor arrows and Home/End move the cursor', () => {
  let ui = keysIn(panel({ input: 'abc' }), '\x1bOH');
  expect(ui.cursor).toBe(0);
  ui = keysIn(ui, '\x1bOC', '\x1b[F');
  expect(ui.cursor).toBe(3);
  expect(keysIn(panel({ input: 'abc' }), '\x1b[1~').cursor).toBe(0);
  expect(keysIn(panel({ input: 'abc', cursor: 0 }), '\x1b[4~').cursor).toBe(3);
});

test('backspace deletes before the cursor, by code point', () => {
  const ui = keysIn(panel({ input: 'a世b', cursor: 2 }), '\x7f');
  expect(ui.input).toBe('ab');
  expect(ui.cursor).toBe(1);
});

test('paste inserts at the cursor', () => {
  const ui = reduce(panel({ input: 'ad', cursor: 1 }), { type: 'paste', text: 'bc' }).ui;
  expect(ui.input).toBe('abcd');
  expect(ui.cursor).toBe(3);
});

test('up and down walk submitted prompts and restore the draft', () => {
  let ui = keysIn(panel(), 'one\r');
  ui = { ...ui, mode: 'idle' };
  ui = keysIn(ui, 'two\r');
  ui = { ...ui, mode: 'idle' };
  ui = keysIn(ui, 'dra', '\x1b[A');
  expect(ui.input).toBe('two');
  ui = keysIn(ui, '\x1b[A', '\x1b[A');
  expect(ui.input).toBe('one');
  ui = keysIn(ui, '\x1b[B', '\x1b[B');
  expect(ui.input).toBe('dra');
  expect(ui.historyAt).toBeUndefined();
});

test('/clear emits clear-chat instead of submitting', () => {
  const r = reduce(panel({ input: ' /clear ' }), bytes('\r'));
  expect(r.actions).toEqual([{ type: 'clear-chat' }]);
  expect(r.ui.input).toBe('');
  expect(r.ui.mode).toBe('idle');
});

test('ctrl+l in the panel emits clear-chat, also when busy', () => {
  expect(reduce(panel(), bytes('\x0c')).actions).toEqual([{ type: 'clear-chat' }]);
  expect(reduce(panel({ mode: 'busy' }), bytes('\x0c')).actions).toEqual([{ type: 'clear-chat' }]);
});

test('the same prompt twice in a row is stored once', () => {
  let ui = keysIn(panel(), 'ls\r');
  ui = keysIn({ ...ui, mode: 'idle' }, 'ls\r');
  expect(ui.history).toEqual(['ls']);
});

test('up during card edit does not recall history', () => {
  const editing = keysIn({ ...withCard(), history: ['old'] }, 'e');
  const ui = keysIn(editing, '\x1b[A');
  expect(ui.input).toBe('rm -rf\r');
});

test('left arrow works in the card edit input', () => {
  const ui = keysIn(withCard(), 'e', '\x1b[D', 'X');
  expect(ui.input.endsWith('X\r')).toBe(true);
});

test('escape on an idle panel closes it and returns focus to the terminal', () => {
  const r = reduce(panel(), bytes('\x1b'));
  expect(r.ui.focus).toBe('terminal');
  expect(r.ui.open).toBe(false);
  expect(r.actions).toEqual([{ type: 'layout-changed' }]);
});

test('ctrl+k reopens the panel from a closed terminal', () => {
  const closed = reduce(panel(), bytes('\x1b')).ui;
  expect(closed.open).toBe(false);
  const r = reduce(closed, { type: 'agent-key' });
  expect(r.ui.open).toBe(true);
  expect(r.ui.focus).toBe('panel');
  expect(r.actions).toEqual([{ type: 'layout-changed' }]);
});

test('escape while busy with no card cancels the task', () => {
  const r = reduce(panel({ mode: 'busy' }), bytes('\x1b'));
  expect(r.actions).toEqual([{ type: 'cancel-task' }]);
});

test('an escape sequence is ignored in the panel', () => {
  const r = reduce(panel(), bytes('\x1b[A'));
  expect(r.actions).toEqual([]);
  expect(r.ui.focus).toBe('panel');
  expect(r.ui.input).toBe('');
});

test('y approves with allowRest false and clears the card', () => {
  const r = reduce(withCard(), bytes('y'));
  expect(r.actions).toEqual([
    { type: 'decide', decision: { kind: 'approve', keys: 'rm -rf\r', allowRest: false } },
  ]);
  expect(r.ui.card).toBeNull();
});

test('a approves and allows the rest of the task', () => {
  const r = reduce(withCard(), bytes('a'));
  expect(r.actions).toEqual([
    { type: 'decide', decision: { kind: 'approve', keys: 'rm -rf\r', allowRest: true } },
  ]);
  expect(r.ui.card).toBeNull();
});

test('typing on a plain card does not edit the input line', () => {
  const r = reduce(withCard(), bytes('jkl'));
  expect(r.ui.input).toBe('');
  expect(r.actions).toEqual([]);
});

test('a truncated card ignores y', () => {
  const r = reduce(truncatedCard(), bytes('y'));
  expect(r.actions).toEqual([]);
  expect(r.ui.card).not.toBeNull();
});

test('a truncated card ignores a', () => {
  const r = reduce(truncatedCard(), bytes('a'));
  expect(r.actions).toEqual([]);
  expect(r.ui.card).not.toBeNull();
});

test('a truncated card still denies with n', () => {
  const r = reduce(truncatedCard(), bytes('n'));
  expect(r.ui.card?.denying).toBe(true);
  expect(r.actions).toEqual([]);
});

test('a truncated card still edits with e', () => {
  const r = reduce(truncatedCard(), bytes('e'));
  expect(r.ui.card?.editing).toBe(true);
  expect(r.ui.input).toBe('rm -rf\r');
});

test('n starts a denial reason and enter denies with it', () => {
  const started = reduce(withCard(), bytes('n')).ui;
  expect(started.card?.denying).toBe(true);
  const r = reduce({ ...started, inputTruncated: false }, bytes('no\r'));
  expect(r.actions).toEqual([{ type: 'decide', decision: { kind: 'deny', reason: 'no' } }]);
  expect(r.ui.card).toBeNull();
});

test('escape with a card denies with an empty reason', () => {
  const r = reduce(withCard(), bytes('\x1b'));
  expect(r.actions).toEqual([{ type: 'decide', decision: { kind: 'deny', reason: '' } }]);
  expect(r.ui.card).toBeNull();
});

test('e prefills the input for editing and enter approves the edit', () => {
  const editing = reduce(withCard(), bytes('e')).ui;
  expect(editing.card?.editing).toBe(true);
  expect(editing.input).toBe('rm -rf\r');
  const r = reduce({ ...editing, input: 'rm -rf /', inputTruncated: false, inputShown: true }, bytes('\r'));
  expect(r.actions).toEqual([
    { type: 'decide', decision: { kind: 'approve', keys: 'rm -rf /', allowRest: false } },
  ]);
  expect(r.ui.card).toBeNull();
});

test('entering edit mode marks the field truncated and not yet shown', () => {
  const editing = reduce(withCard(), bytes('e')).ui;
  expect(editing.inputTruncated).toBe(true);
  expect(editing.inputShown).toBe(false);
});

test('entering deny mode marks the field truncated and not yet shown', () => {
  const denying = reduce(withCard(), bytes('n')).ui;
  expect(denying.inputTruncated).toBe(true);
  expect(denying.inputShown).toBe(false);
});

test('e and enter in one chunk do not approve an unseen edit', () => {
  const r = reduce(withCard(), bytes('e\r'));
  expect(r.actions).toEqual([]);
  expect(r.ui.card?.editing).toBe(true);
  expect(r.ui.input).toBe('rm -rf\r');
});

test('enter does not approve an edit before the field is first drawn', () => {
  const editing = reduce(withCard(), bytes('e')).ui;
  const r = reduce(editing, bytes('\r'));
  expect(r.actions).toEqual([]);
  expect(r.ui.card?.editing).toBe(true);
});

test('typing in the edit field clears the shown marker until the next draw', () => {
  const editing = { ...reduce(withCard(), bytes('e')).ui, inputTruncated: false, inputShown: true };
  const typed = reduce(editing, bytes('x')).ui;
  expect(typed.inputShown).toBe(false);
  const r = reduce(typed, bytes('\r'));
  expect(r.actions).toEqual([]);
  expect(r.ui.card?.editing).toBe(true);
});

test('enter in the edit field does nothing while the input is truncated', () => {
  const editing = reduce(withCard(), bytes('e')).ui;
  const r = reduce({ ...editing, input: 'x'.repeat(200), inputTruncated: true, inputShown: true }, bytes('\r'));
  expect(r.actions).toEqual([]);
  expect(r.ui.card?.editing).toBe(true);
});

test('enter approves an edit once the field is drawn and fits', () => {
  const editing = reduce(withCard(), bytes('e')).ui;
  const r = reduce({ ...editing, input: 'rm -rf /', inputTruncated: false, inputShown: true }, bytes('\r'));
  expect(r.actions).toEqual([
    { type: 'decide', decision: { kind: 'approve', keys: 'rm -rf /', allowRest: false } },
  ]);
});

test('pasting into the edit field strips carriage returns and newlines', () => {
  const editing = reduce(withCard(), bytes('e')).ui;
  const r = reduce({ ...editing, input: '' }, { type: 'paste', text: 'a\r\nb' });
  expect(r.ui.input).toBe('ab');
});

test('a pending card does not steal bytes while the terminal has focus', () => {
  const event = bytes('secret\r');
  const r = reduce(withCard({ focus: 'terminal' }), event);
  expect(r.actions).toEqual([{ type: 'to-pty', event }]);
  expect(r.ui.card).not.toBeNull();
});

test('agent-key with a pending card focuses the panel and keeps the card', () => {
  const r = reduce(withCard({ focus: 'terminal' }), { type: 'agent-key' });
  expect(r.ui.focus).toBe('panel');
  expect(r.ui.card).not.toBeNull();
  expect(r.actions).toEqual([]);
});

test('focus events go to the pty with terminal focus', () => {
  const event: InputEvent = { type: 'focus', focused: true };
  const r = reduce(initialUi(), event);
  expect(r.actions).toEqual([{ type: 'to-pty', event }]);
});

test('focus events are dropped with panel focus', () => {
  const event: InputEvent = { type: 'focus', focused: false };
  const r = reduce(panel(), event);
  expect(r.actions).toEqual([]);
});

test('mouse events are dropped with panel focus', () => {
  const event: InputEvent = { type: 'mouse', button: 0, col: 5, row: 5, action: 'press' };
  const r = reduce(panel(), event);
  expect(r.actions).toEqual([]);
});

test('mouse events go to the pty with terminal focus', () => {
  const event: InputEvent = { type: 'mouse', button: 0, col: 5, row: 5, action: 'press' };
  const r = reduce(initialUi(), event);
  expect(r.actions).toEqual([{ type: 'to-pty', event }]);
});

test('page keys go to the pty with terminal focus', () => {
  const event: InputEvent = { type: 'page-key', direction: 'up', data: '\x1b[5;2~' };
  const r = reduce(initialUi(), event);
  expect(r.actions).toEqual([{ type: 'to-pty', event }]);
});

test('page keys are dropped with panel focus', () => {
  const r = reduce(panel(), { type: 'page-key', direction: 'down', data: '\x1b[6;2~' });
  expect(r.actions).toEqual([]);
});

test('help-key opens help from any focus without actions', () => {
  for (const state of [
    initialUi(),
    panel(),
    withCard(),
    { ...initialUi(), open: true, focus: 'panel' as const, mode: 'busy' as const },
  ]) {
    const r = reduce(state, { type: 'help-key' });
    expect(r.ui.help).toBe(true);
    expect(r.actions).toEqual([]);
  }
});

test('while help is open other keys are dropped', () => {
  const help = { ...panel({ input: 'ab' }), help: true };
  const typed = reduce(help, bytes('cd'));
  expect(typed.ui.help).toBe(true);
  expect(typed.ui.input).toBe('ab');
  expect(typed.actions).toEqual([]);

  const terminalHelp = { ...initialUi(), help: true };
  expect(reduce(terminalHelp, bytes('ls\r')).actions).toEqual([]);
  expect(reduce(terminalHelp, { type: 'paste', text: 'x' }).actions).toEqual([]);
  expect(reduce(terminalHelp, { type: 'page-key', direction: 'up', data: '\x1b[5;2~' }).actions).toEqual([]);
  expect(
    reduce(terminalHelp, { type: 'mouse', button: 0, col: 1, row: 1, action: 'press' }).actions,
  ).toEqual([]);
  expect(reduce(terminalHelp, { type: 'focus', focused: true }).actions).toEqual([]);
});

test('help-key or escape closes help', () => {
  const help = { ...initialUi(), help: true };
  expect(reduce(help, { type: 'help-key' }).ui.help).toBe(false);
  expect(reduce(help, bytes('\x1b')).ui.help).toBe(false);
  expect(reduce(help, bytes('\x1b')).actions).toEqual([]);
});

test('agent-key still toggles focus while help stays open', () => {
  const help = { ...initialUi(), help: true };
  const reopened = reduce(help, { type: 'agent-key' });
  expect(reopened.ui.help).toBe(true);
  expect(reopened.ui.open).toBe(true);
  expect(reopened.ui.focus).toBe('panel');

  const closed = reduce({ ...reopened.ui, focus: 'panel' }, { type: 'agent-key' });
  expect(closed.ui.help).toBe(true);
  expect(closed.ui.focus).toBe('terminal');
});
