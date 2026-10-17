import { expect, test } from 'vitest';

import xterm from '@xterm/headless';
import type { Terminal } from '@xterm/headless';

import {
  DEFAULT_HOST_MODES,
  hostModeDiff,
  hostModesFrom,
  trackModes,
} from '../../src/term/modes.js';

const { Terminal: XtermTerminal } = xterm;

function write(term: Terminal, data: string): Promise<void> {
  return new Promise<void>(r => term.write(data, r));
}

test('tracks SGR mouse', async () => {
  const term = new XtermTerminal({ allowProposedApi: true });
  const tracked = trackModes(term);
  await write(term, '\x1b[?1006h');
  expect(tracked.get().mouseSgr).toBe(true);
  await write(term, '\x1b[?1006l');
  expect(tracked.get().mouseSgr).toBe(false);
  tracked.dispose();
});

test('tracks cursor visibility', async () => {
  const term = new XtermTerminal({ allowProposedApi: true });
  const tracked = trackModes(term);
  await write(term, '\x1b[?25l');
  expect(tracked.get().cursorVisible).toBe(false);
  await write(term, '\x1b[?25h');
  expect(tracked.get().cursorVisible).toBe(true);
  tracked.dispose();
});

test('tracks cursor style', async () => {
  const term = new XtermTerminal({ allowProposedApi: true });
  const tracked = trackModes(term);
  await write(term, '\x1b[5 q');
  expect(tracked.get().cursorStyle).toBe(5);
  tracked.dispose();
});

test('does not swallow modes xterm needs', async () => {
  const term = new XtermTerminal({ allowProposedApi: true });
  const tracked = trackModes(term);
  await write(term, '\x1b[?1h');
  expect(term.modes.applicationCursorKeysMode).toBe(true);
  tracked.dispose();
});

test('hostModesFrom reads the mirror modes', async () => {
  const term = new XtermTerminal({ allowProposedApi: true });
  const tracked = trackModes(term);
  await write(term, '\x1b[?1h\x1b[?66h\x1b[?1003h\x1b[5 q');
  const host = hostModesFrom(term, tracked.get());
  expect(host).toEqual({ appCursor: true, appKeypad: true, mouse: 'any', cursorStyle: 5 });
  tracked.dispose();
});

test('hostModeDiff is empty for identical modes', () => {
  expect(hostModeDiff(DEFAULT_HOST_MODES, DEFAULT_HOST_MODES)).toBe('');
});

test('hostModeDiff enables app cursor keys', () => {
  expect(hostModeDiff(DEFAULT_HOST_MODES, { ...DEFAULT_HOST_MODES, appCursor: true })).toBe(
    '\x1b[?1h',
  );
});

test('hostModeDiff switches mouse mode with the three disables first', () => {
  const prev = { ...DEFAULT_HOST_MODES, mouse: 'vt200' as const };
  const next = { ...DEFAULT_HOST_MODES, mouse: 'any' as const };
  expect(hostModeDiff(prev, next)).toBe('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1003h');
});

test('hostModeDiff mirrors app keypad', () => {
  expect(hostModeDiff(DEFAULT_HOST_MODES, { ...DEFAULT_HOST_MODES, appKeypad: true })).toBe('\x1b=');
  expect(hostModeDiff({ ...DEFAULT_HOST_MODES, appKeypad: true }, DEFAULT_HOST_MODES)).toBe('\x1b>');
});

test('hostModeDiff mirrors cursor style', () => {
  expect(hostModeDiff(DEFAULT_HOST_MODES, { ...DEFAULT_HOST_MODES, cursorStyle: 5 })).toBe(
    '\x1b[5 q',
  );
});

test('hostModeDiff emits the full state for a null previous', () => {
  expect(hostModeDiff(null, DEFAULT_HOST_MODES)).toBe(
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1l\x1b>\x1b[0 q',
  );
});
