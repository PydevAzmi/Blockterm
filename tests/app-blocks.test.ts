import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';

import type { Config, LoadResult } from '../src/config.js';
import type { ModelResult } from '../src/agent/model.js';
import { runApp } from '../src/app.js';
import { TerminalSession } from '../src/term/session.js';
import { FakePty } from './helpers/fake-pty.js';

process.setMaxListeners(0);

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function reply(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

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

function startApp(o: {
  load?: () => LoadResult;
  model?: (config: Config, sessionId?: string) => ModelResult;
} = {}): { run: Promise<number>; pty: FakePty; stdin: FakeStdin; stdout: FakeStdout } {
  const pty = new FakePty();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(80, 24);
  const run = runApp({
    shell: { file: 'fake-shell', args: [] },
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    createSession: (_shell, size) => new TerminalSession(pty, size),
    loadConfig: o.load ?? (() => LOADED),
    ...(o.model !== undefined ? { modelFactory: o.model } : {}),
  });
  return { run, pty, stdin, stdout };
}

function okModel(model: MockLanguageModelV4): (config: Config) => ModelResult {
  return () => ({ ok: true, model, label: CONFIG.model });
}

function failedCycle(body = 'boom', command = 'npm test'): string {
  const prompt = '\x1b]133;A\x07$ \x1b]133;B\x07';
  return (
    `${osc7(FOLDER)}${prompt}${command}\r\n` +
    `\x1b]133;C\x07${body}\r\n\x1b]133;D;1\x07${prompt}`
  );
}

function labelAt(stdout: FakeStdout): { row: number; col: number } {
  const rows = renderScreen(stdout);
  const row = rows.findIndex(line => line.includes('[Explain error]'));
  if (row < 0) throw new Error('label not found');
  return { row, col: rows[row]!.indexOf('[Explain error]') };
}

function clickLabel(stdin: FakeStdin, stdout: FakeStdout): void {
  const { row, col } = labelAt(stdout);
  stdin.emit('data', `\x1b[<0;${col + 1};${row + 1}M`);
  stdin.emit('data', `\x1b[<0;${col + 1};${row + 1}m`);
}

function osc7(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const url = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `\x1b]7;file://host${url}\x07`;
}

function osc7Path(path: string): string {
  return path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
}

function cycle(body: string, after = true, folder = FOLDER): string {
  const prompt = after ? '\x1b]133;A\x07$ \x1b]133;B\x07' : '';
  return (
    `${osc7(folder)}\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n` +
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

test('the wheel does not reach the pty, including with modifier bits', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle(lines(20)));
  await until(() => output(stdout).includes('L20'));

  stdin.emit('data', '\x1b[<68;5;5M');
  await until(() => output(stdout).includes('┌ $ ls'));
  expect(pty.written).toEqual([]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the wheel reaches the pty when the inner program asked for mouse', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle(lines(20)));
  await until(() => output(stdout).includes('L20'));
  pty.emit('\x1b[?1000h\x1b[?1006h');
  await wait(30);

  stdin.emit('data', '\x1b[<64;5;5M');
  await until(() => pty.written.length > 0);
  expect(pty.written.map(String).join('')).toMatch(/\x1b\[<64;\d+;\d+M/);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('shift+PgUp is written to the pty byte-exact without integration', async () => {
  const { run, pty, stdin } = startApp();

  stdin.emit('data', '\x1b[5;2~');
  await until(() => pty.written.length > 0);
  expect(pty.written).toEqual(['\x1b[5;2~']);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('typing a character resets the scroll position', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle(lines(20)));
  await until(() => output(stdout).includes('L20'));
  stdin.emit('data', '\x1b[<64;5;5M');
  await until(() => output(stdout).includes('┌ $ ls'));

  stdin.emit('data', 'x');
  await until(() => !output(stdout).includes('┌ $ ls'));
  expect(output(stdout)).toContain('L20');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('new output while scrolled up keeps the same rows in place', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle(lines(20)));
  await until(() => output(stdout).includes('L20'));

  stdin.emit('data', '\x1b[<64;5;5M');
  await until(() => output(stdout).includes('┌ $ ls'));
  const before = renderScreen(stdout);
  const index = before.findIndex(row => row.includes('L20'));
  expect(index).toBeGreaterThan(0);

  pty.emit('more\r\nmore2\r\n');
  await until(() => output(stdout).includes('↓ new output'));
  await until(() => (renderScreen(stdout)[index] ?? '').includes('L20'));
  const after = renderScreen(stdout);
  expect(after[index]).toContain('L20');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the header re-reads the git branch when a block finishes', async () => {
  const root = mkdtempSync(join(process.cwd(), '.blockterm-branch-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const folder = osc7Path(root);

  try {
    const { run, pty, stdout } = startApp();

    pty.emit(cycle('a', true, folder));
    await until(() => output(stdout).includes('(main)'));

    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/dev\n');
    pty.emit(cycle('b', true, folder));
    await until(() => output(stdout).includes('(dev)'));

    pty.exit(0);
    await expect(run).resolves.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ctrl+l in the fullscreen view goes to the pty', async () => {
  const { run, pty, stdin } = startApp();

  pty.emit('\x1b[?1049h');
  pty.emit('\x1b]133;A\x07$ \x1b]133;B\x07');
  await wait(30);

  stdin.emit('data', '\x0c');
  await until(() => pty.written.map(String).join('').includes('\x0c'));

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('clicking [Explain error] opens the panel and explains the failed block', async () => {
  let release: (value: unknown) => void = () => {};
  const model = new MockLanguageModelV4({
    doGenerate: () =>
      new Promise(resolve => {
        release = resolve;
      }),
  });
  const { run, pty, stdin, stdout } = startApp({ model: okModel(model) });

  pty.emit(failedCycle('Error: boom'));
  await until(() => output(stdout).includes('[Explain error]'));
  expect(output(stdout)).not.toContain('agent · claude-haiku-5-5');

  clickLabel(stdin, stdout);
  await until(() => model.doGenerateCalls.length === 1);
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  await until(() => output(stdout).includes('Explain error: $ npm test (exit 1)'));
  expect(output(stdout)).toContain('agent busy');

  const call = model.doGenerateCalls[0]!;
  expect(call.tools ?? []).toEqual([]);
  const prompt = JSON.stringify(call.prompt);
  expect(prompt).toContain('Command: npm test');
  expect(prompt).toContain('Exit code: 1');
  expect(prompt).toContain('Error: boom');

  release(reply('Cause: boom.\nFix: rerun tests'));
  await until(() => output(stdout).includes('Cause: boom.'));
  await until(() => !output(stdout).includes('agent busy'));
  await wait(30);
  expect(model.doGenerateCalls).toHaveLength(1);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('Esc in the panel cancels a running explanation', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: options =>
      new Promise((_, reject) => {
        options.abortSignal?.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
  });
  const { run, pty, stdin, stdout } = startApp({ model: okModel(model) });

  pty.emit(failedCycle('Error: boom'));
  await until(() => output(stdout).includes('[Explain error]'));

  clickLabel(stdin, stdout);
  await until(() => model.doGenerateCalls.length === 1);
  await until(() => output(stdout).includes('agent busy'));

  stdin.emit('data', '\x1b');
  await until(() => output(stdout).includes('cancelled'));
  expect(output(stdout)).not.toContain('agent busy');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('clicking [Explain error] while an agent task is busy does nothing', async () => {
  const model = new MockLanguageModelV4({
    doStream: () => new Promise(() => {}),
    doGenerate: async () => reply('should not happen'),
  });
  const { run, pty, stdin, stdout } = startApp({ model: okModel(model) });

  pty.emit(failedCycle('Error: boom'));
  await until(() => output(stdout).includes('[Explain error]'));

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('hello'));
  await until(() => output(stdout).includes('agent busy'));

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('[Explain error]'));
  clickLabel(stdin, stdout);
  await wait(50);

  expect(model.doGenerateCalls).toHaveLength(0);
  expect(output(stdout)).toContain('agent busy');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('clicks elsewhere do nothing', async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => reply('nope') });
  const { run, pty, stdin, stdout } = startApp({ model: okModel(model) });

  pty.emit(failedCycle('Error: boom'));
  await until(() => output(stdout).includes('[Explain error]'));
  const { row } = labelAt(stdout);

  stdin.emit('data', `\x1b[<0;40;${row + 1}M`);
  await wait(50);

  expect(model.doGenerateCalls).toHaveLength(0);
  expect(pty.written).toEqual([]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the explain click goes to the pty when the inner program asked for mouse', async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => reply('nope') });
  const { run, pty, stdin, stdout } = startApp({ model: okModel(model) });

  pty.emit(failedCycle('Error: boom'));
  await until(() => output(stdout).includes('[Explain error]'));
  pty.emit('\x1b[?1000h\x1b[?1006h');
  await wait(30);

  clickLabel(stdin, stdout);
  await until(() => pty.written.map(String).join('').includes('\x1b[<0;'));
  expect(model.doGenerateCalls).toHaveLength(0);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('without config Explain error shows the hint and never calls the model', async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => reply('nope') });
  const { run, pty, stdin, stdout } = startApp({
    load: () => ({ ok: false, reason: 'missing', message: 'no config' }),
    model: okModel(model),
  });

  pty.emit(failedCycle('Error: boom'));
  await until(() => output(stdout).includes('[Explain error]'));

  clickLabel(stdin, stdout);
  await until(() => output(stdout).includes('Run `blockterm setup` to choose a model'));
  expect(model.doGenerateCalls).toHaveLength(0);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});
