import { EventEmitter } from 'node:events';

import { expect, test } from 'vitest';

import type { Config, LoadResult } from '../src/config.js';
import { runApp } from '../src/app.js';
import { TerminalSession } from '../src/term/session.js';
import { FakePty } from './helpers/fake-pty.js';

process.setMaxListeners(0);

const CONFIG: Config = {
  provider: '@ai-sdk/anthropic',
  model: 'claude-haiku-5-5',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseURL: null,
  name: null,
  shell: null,
  headers: null,
  sessionHeader: null,
};

const LOADED: LoadResult = { ok: true, config: CONFIG };
const FOLDER = '/blockterm-app-test';

class FakeStdin extends EventEmitter {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  resume(): this {
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

function renderScreen(stdout: FakeStdout): string[] {
  const rows: string[][] = [];
  let row = 0;
  let col = 0;
  const text = stdout.writes.join('');
  const csi = /^\x1b\[([0-9;?]*)[\x20-\x2f]*([@-~])/;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\x1b') {
      const match = csi.exec(text.slice(i));
      if (match) {
        if (match[2] === 'H') {
          const [r, c] = match[1]!.split(';');
          row = (Number(r) || 1) - 1;
          col = (Number(c) || 1) - 1;
        }
        i += match[0].length;
      } else {
        i += Math.min(2, text.length - i);
      }
      continue;
    }
    if (ch === '\n') {
      row += 1;
      col = 0;
      i += 1;
      continue;
    }
    if (ch === '\r') {
      col = 0;
      i += 1;
      continue;
    }
    rows[row] ??= [];
    rows[row]![col] = ch;
    col += 1;
    i += 1;
  }
  return rows.map(r => (r ?? []).map(c => c ?? ' ').join(''));
}

function output(stdout: FakeStdout): string {
  return renderScreen(stdout).join('\n');
}

function wait(ms = 1): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await wait();
  }
}

function startApp(): { run: Promise<number>; pty: FakePty; stdin: FakeStdin; stdout: FakeStdout } {
  const pty = new FakePty();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(80, 24);
  const run = runApp({
    shell: { file: 'fake-shell', args: [] },
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    createSession: (_shell, size) => new TerminalSession(pty, size),
    loadConfig: () => LOADED,
  });
  return { run, pty, stdin, stdout };
}

function osc7(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const url = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `\x1b]7;file://host${url}\x07`;
}

function cycle(body: string, after = true): string {
  const prompt = after ? '\x1b]133;A\x07$ \x1b]133;B\x07' : '';
  return (
    `${osc7(FOLDER)}\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n` +
    `\x1b]133;C\x07${body}\r\n\x1b]133;D;0\x07${prompt}`
  );
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `L${String(i + 1).padStart(2, '0')}`).join(
    '\r\n',
  );
}

test('a finished block is drawn in the blocks view', async () => {
  const { run, pty, stdout } = startApp();

  pty.emit(cycle('a\r\nb'));
  await until(() => output(stdout).includes('┌ $ ls'));
  expect(output(stdout)).toContain('┌ $ ls');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the header shows the OSC 7 folder', async () => {
  const { run, pty, stdout } = startApp();

  pty.emit(`${osc7(FOLDER)}\x1b]133;A\x07$ \x1b]133;B\x07`);
  await until(() => output(stdout).includes(FOLDER));
  expect(output(stdout)).toContain(`blockterm  ${FOLDER}`);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the wheel scrolls up and new output shows the footer marker', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle(lines(20)));
  await until(() => output(stdout).includes('L20'));
  expect(output(stdout)).not.toContain('┌ $ ls');

  stdin.emit('data', '\x1b[<64;5;5M');
  await until(() => output(stdout).includes('┌ $ ls'));
  expect(output(stdout)).not.toContain('↓ new output');

  pty.emit('more\r\n');
  await until(() => output(stdout).includes('↓ new output'));

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('shift+PgUp scrolls a page', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle(lines(30)));
  await until(() => output(stdout).includes('L30'));
  expect(output(stdout)).not.toContain('L01');

  stdin.emit('data', '\x1b[5;2~');
  await until(() => output(stdout).includes('L01'));
  expect(output(stdout)).toContain('┌ $ ls');
  expect(output(stdout)).not.toContain('L30');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('ctrl+l at an idle prompt clears blocks without reaching the pty', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle('a'));
  await until(() => output(stdout).includes('┌ $ ls'));
  pty.emit('\x1b]133;A\x07$ \x1b]133;B\x07');
  await wait(30);

  stdin.emit('data', '\x0c');
  await until(() => !output(stdout).includes('┌ $ ls'));
  expect(pty.written.map(String).join('')).not.toContain('\x0c');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('ctrl+l while running is written to the pty', async () => {
  const { run, pty, stdin } = startApp();

  pty.emit(`${osc7(FOLDER)}\x1b]133;A\x07$ \x1b]133;B\x07sleep\r\n\x1b]133;C\x07`);
  await wait(30);

  stdin.emit('data', '\x0c');
  await until(() => pty.written.map(String).join('').includes('\x0c'));

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});
