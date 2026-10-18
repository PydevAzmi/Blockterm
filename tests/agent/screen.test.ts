import { expect, test, vi } from 'vitest';

import xterm from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';

import { readScreen, readScrollback, waitForQuiet } from '../../src/agent/screen.js';
import type { View } from '../../src/term/session.js';

const { Terminal: XtermTerminal } = xterm;

interface FakeSession {
  onParsed(cb: () => void): { dispose(): void };
  emit(): void;
  listeners(): number;
}

function fakeSession(): FakeSession {
  const set = new Set<() => void>();
  return {
    onParsed(cb) {
      set.add(cb);
      return { dispose: () => void set.delete(cb) };
    },
    emit() {
      for (const cb of [...set]) cb();
    },
    listeners: () => set.size,
  };
}

function makeMirror(cols = 20, rows = 5): Terminal {
  const mirror = new XtermTerminal({ allowProposedApi: true, scrollback: 1000, cols, rows });
  mirror.loadAddon(new Unicode11Addon());
  mirror.unicode.activeVersion = '11';
  return mirror;
}

function write(mirror: Terminal, data: string): Promise<void> {
  return new Promise<void>(resolve => mirror.write(data, resolve));
}

function screen(mirror: Terminal, view: View = 'blocks', program = 'bash') {
  return { mirror, view, program };
}

test('readScreen: trimmed text, cursor, buffer, view, program and size', async () => {
  const mirror = makeMirror(20, 5);
  await write(mirror, 'hi\r\nthere');
  const info = readScreen(screen(mirror));
  expect(info.text).toBe('hi\nthere');
  expect(info.cursor).toEqual({ row: 1, col: 5 });
  expect(info.buffer).toBe('normal');
  expect(info.view).toBe('blocks');
  expect(info.program).toBe('bash');
  expect(info.size).toEqual({ cols: 20, rows: 5 });
});

test('readScreen: alternate buffer is reported', async () => {
  const mirror = makeMirror(20, 5);
  await write(mirror, '\x1b[?1049h');
  const info = readScreen(screen(mirror, 'fullscreen', 'vim'));
  expect(info.buffer).toBe('alternate');
  expect(info.view).toBe('fullscreen');
  expect(info.program).toBe('vim');
});

test('readScrollback: caps at 500 lines, oldest first, last is newest', async () => {
  const mirror = makeMirror(20, 5);
  const data = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\r\n');
  await write(mirror, data);
  const out = readScrollback(mirror, 9999);
  const lines = out.split('\n');
  expect(lines.length).toBe(500);
  expect(lines[0]).toBe('line 100');
  expect(lines[lines.length - 1]).toBe('line 599');
});

test('waitForQuiet: resolves 400 ms after the last parse event', async () => {
  vi.useFakeTimers();
  try {
    const s = fakeSession();
    const p = waitForQuiet(s, 15000);
    let settled = false;
    void p.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    s.emit();
    await vi.advanceTimersByTimeAsync(399);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe(true);
    expect(s.listeners()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('waitForQuiet: resolves at maxMs when parse events keep coming', async () => {
  vi.useFakeTimers();
  try {
    const s = fakeSession();
    const p = waitForQuiet(s, 1000);
    let settled = false;
    void p.then(() => {
      settled = true;
    });

    for (let t = 0; t < 800; t += 200) {
      await vi.advanceTimersByTimeAsync(200);
      s.emit();
    }
    await vi.advanceTimersByTimeAsync(199);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe(true);
    expect(s.listeners()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('waitForQuiet: maxMs 99999 is capped to 15000', async () => {
  vi.useFakeTimers();
  try {
    const s = fakeSession();
    const p = waitForQuiet(s, 99999);
    let settled = false;
    void p.then(() => {
      settled = true;
    });

    for (let t = 0; t < 14800; t += 200) {
      await vi.advanceTimersByTimeAsync(200);
      s.emit();
    }
    await vi.advanceTimersByTimeAsync(199);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe(true);
    expect(s.listeners()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('waitForQuiet: resolves immediately when the signal is already aborted', async () => {
  vi.useFakeTimers();
  try {
    const s = fakeSession();
    const controller = new AbortController();
    controller.abort();
    await waitForQuiet(s, 15000, 400, controller.signal);
    expect(s.listeners()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('waitForQuiet: resolves and disposes when aborted while waiting', async () => {
  vi.useFakeTimers();
  try {
    const s = fakeSession();
    const controller = new AbortController();
    const p = waitForQuiet(s, 15000, 400, controller.signal);
    let settled = false;
    void p.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    controller.abort();
    await p;
    expect(settled).toBe(true);
    expect(s.listeners()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
