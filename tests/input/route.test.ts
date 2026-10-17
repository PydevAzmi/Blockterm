import { expect, test } from 'vitest';

import type { IModes } from '@xterm/headless';

import { encodeMouse, encodePaste, routeToPty } from '../../src/input/route.js';
import type { MouseInput } from '../../src/input/tokenize.js';
import type { Layout } from '../../src/layout.js';
import type { TrackedModes } from '../../src/term/modes.js';

const layout: Layout = {
  host: { cols: 120, rows: 40 },
  pty: { cols: 116, rows: 37 },
  origin: { row: 1, col: 2 },
};

const m = (o: Partial<IModes>): IModes => o as IModes;

const tracked: TrackedModes = { mouseSgr: false, cursorVisible: true, cursorStyle: 0 };

const press: MouseInput = { type: 'mouse', button: 0, col: 12, row: 6, action: 'press' };

test('SGR press offsets host coords into the PTY', () => {
  expect(encodeMouse(press, 'vt200', true, layout)).toBe('\x1b[<0;11;6M');
});

test('SGR release ends with m', () => {
  expect(encodeMouse({ ...press, action: 'release' }, 'vt200', true, layout)).toBe('\x1b[<0;11;6m');
});

test('mode none drops mouse', () => {
  expect(encodeMouse(press, 'none', true, layout)).toBeNull();
});

test('x10 drops release but passes press', () => {
  expect(encodeMouse({ ...press, action: 'release' }, 'x10', true, layout)).toBeNull();
  expect(encodeMouse(press, 'x10', true, layout)).toBe('\x1b[<0;11;6M');
});

test('vt200 drops motion', () => {
  expect(encodeMouse({ ...press, action: 'motion' }, 'vt200', true, layout)).toBeNull();
});

test('drag encodes motion with a held button but drops unheld motion', () => {
  expect(encodeMouse({ ...press, button: 32, action: 'motion' }, 'drag', true, layout)).toBe(
    '\x1b[<32;11;6M',
  );
  expect(encodeMouse({ ...press, button: 35, action: 'motion' }, 'drag', true, layout)).toBeNull();
});

test('any mode encodes motion without a held button', () => {
  expect(encodeMouse({ ...press, button: 35, action: 'motion' }, 'any', true, layout)).toBe(
    '\x1b[<35;11;6M',
  );
});

test('events outside the PTY area are dropped', () => {
  expect(encodeMouse({ ...press, col: 0 }, 'vt200', true, layout)).toBeNull();
  expect(encodeMouse({ ...press, row: 0 }, 'vt200', true, layout)).toBeNull();
});

test('legacy press encodes with the 32 offset', () => {
  expect(encodeMouse(press, 'vt200', false, layout)).toBe(
    '\x1b[M' + String.fromCharCode(32, 32 + 11, 32 + 6),
  );
});

test('legacy release uses button 3', () => {
  expect(encodeMouse({ ...press, action: 'release' }, 'vt200', false, layout)).toBe(
    '\x1b[M' + String.fromCharCode(32 + 3, 32 + 11, 32 + 6),
  );
});

test('legacy at PTY col 223 or more is dropped', () => {
  expect(encodeMouse({ ...press, col: 225 }, 'vt200', false, layout)).toBeNull();
});

test('legacy drops coordinates that would overflow a byte', () => {
  const wide: Layout = {
    host: { cols: 300, rows: 40 },
    pty: { cols: 240, rows: 37 },
    origin: { row: 1, col: 2 },
  };
  expect(encodeMouse({ ...press, col: 225 }, 'vt200', false, wide)).toBeNull();
});

test('bracketed paste wraps the text', () => {
  expect(encodePaste('a', true)).toBe('\x1b[200~a\x1b[201~');
});

test('unbracketed paste is raw', () => {
  expect(encodePaste('a', false)).toBe('a');
});

test('paste strips embedded end markers', () => {
  expect(encodePaste('x\x1b[201~rm -rf ~\r', true)).toBe('\x1b[200~xrm -rf ~\r\x1b[201~');
});

test('focus is encoded only when the program asked for it', () => {
  const on = { modes: m({ sendFocusMode: true }), tracked, layout };
  const off = { modes: m({ sendFocusMode: false }), tracked, layout };
  expect(routeToPty({ type: 'focus', focused: true }, on)).toBe('\x1b[I');
  expect(routeToPty({ type: 'focus', focused: true }, off)).toBeNull();
});

test('agent-key and help-key are dropped', () => {
  const ctx = { modes: m({}), tracked, layout };
  expect(routeToPty({ type: 'agent-key' }, ctx)).toBeNull();
  expect(routeToPty({ type: 'help-key' }, ctx)).toBeNull();
});

test('bytes pass through unchanged', () => {
  const ctx = { modes: m({}), tracked, layout };
  expect(routeToPty({ type: 'bytes', data: 'ls\r' }, ctx)).toBe('ls\r');
});

test('routeToPty routes mouse and paste through the modes', () => {
  const ctx = {
    modes: m({ mouseTrackingMode: 'vt200', bracketedPasteMode: true }),
    tracked: { ...tracked, mouseSgr: true },
    layout,
  };
  expect(routeToPty(press, ctx)).toBe('\x1b[<0;11;6M');
  expect(routeToPty({ type: 'paste', text: 'a' }, ctx)).toBe('\x1b[200~a\x1b[201~');
});
