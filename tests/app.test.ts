import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { runApp } from '../src/app.js';
import { TerminalSession } from '../src/term/session.js';
import { FakePty } from './helpers/fake-pty.js';

class FakeStdin extends EventEmitter {
  readonly rawModes: boolean[] = [];
  readonly encodings: string[] = [];
  paused = false;

  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    return this;
  }

  setEncoding(encoding: string): this {
    this.encodings.push(encoding);
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }
}

class FakeStdout extends EventEmitter {
  readonly writes: string[] = [];

  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function startApp(): { run: Promise<number>; pty: FakePty; stdin: FakeStdin; stdout: FakeStdout } {
  const pty = new FakePty();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(80, 24);
  const session = new TerminalSession(pty, { cols: 76, rows: 21 });
  const run = runApp({
    shell: { file: 'fake', args: [] },
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    createSession: () => session,
  });
  return { run, pty, stdin, stdout };
}

test('runApp silences the AI SDK warning logger', async () => {
  globalThis.AI_SDK_LOG_WARNINGS = true;
  const { run, pty } = startApp();
  expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a pending resize debounce suppresses old-size frames', async () => {
  const { run, pty, stdout } = startApp();

  await vi.advanceTimersByTimeAsync(1);
  const baseline = stdout.writes.length;
  expect(baseline).toBeGreaterThan(0);

  stdout.columns = 100;
  stdout.rows = 30;
  stdout.emit('resize');

  pty.emit('output');
  await vi.advanceTimersByTimeAsync(16);
  expect(stdout.writes.length).toBe(baseline);

  await vi.advanceTimersByTimeAsync(60);
  expect(pty.resizes).toEqual([[96, 27]]);
  expect(stdout.writes.length).toBeGreaterThan(baseline);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});
