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

test('escape with no card gives the terminal focus', () => {
  const r = reduce(panel(), bytes('\x1b'));
  expect(r.ui.focus).toBe('terminal');
  expect(r.actions).toEqual([]);
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

test('n starts a denial reason and enter denies with it', () => {
  const started = reduce(withCard(), bytes('n')).ui;
  expect(started.card?.denying).toBe(true);
  const r = reduce(started, bytes('no\r'));
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
  const r = reduce({ ...editing, input: 'rm -rf /' }, bytes('\r'));
  expect(r.actions).toEqual([
    { type: 'decide', decision: { kind: 'approve', keys: 'rm -rf /', allowRest: false } },
  ]);
  expect(r.ui.card).toBeNull();
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
