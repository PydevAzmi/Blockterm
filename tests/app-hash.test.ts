import { EventEmitter } from 'node:events';

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
const PROMPT = '\x1b]133;A\x07$ \x1b]133;B\x07';

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
  model?: (c: Config, sessionId?: string) => ModelResult;
}): { run: Promise<number>; pty: FakePty; stdin: FakeStdin; stdout: FakeStdout } {
  const pty = new FakePty();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(80, 24);
  const run = runApp({
    shell: { file: 'fake-shell', args: [] },
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    createSession: (_shell, size) => new TerminalSession(pty, size),
    loadConfig: o.load,
    modelFactory: o.model,
  });
  return { run, pty, stdin, stdout };
}

function okModel(model: MockLanguageModelV4): (c: Config) => ModelResult {
  return () => ({ ok: true, model, label: CONFIG.model });
}

async function openHash(app: {
  pty: FakePty;
  stdin: FakeStdin;
  stdout: FakeStdout;
}): Promise<void> {
  app.pty.emit(PROMPT);
  await until(() => output(app.stdout).includes('$'));
  app.stdin.emit('data', '#');
  await until(() => output(app.stdout).includes('# '));
}

test('hash opens at an empty idle prompt and writes only the cleaned suggestion', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => reply('```\nfind . -size +100M\n```'),
  });
  const app = startApp({ load: () => LOADED, model: okModel(model) });

  await openHash(app);
  expect(app.pty.written).toEqual([]);
  expect(output(app.stdout)).toContain('# ');

  app.stdin.emit('data', 'list big files');
  await until(() => output(app.stdout).includes('# list big files'));
  expect(app.pty.written).toEqual([]);

  app.stdin.emit('data', '\r');
  await until(() => model.doGenerateCalls.length === 1);
  await until(() => app.pty.written.length > 0);
  expect(app.pty.written.map(String).join('')).toBe('find . -size +100M');
  await until(() => !output(app.stdout).includes('# list big files'));

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('a multiline suggestion writes the first line only', async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => reply('rm x\r\nreboot') });
  const app = startApp({ load: () => LOADED, model: okModel(model) });

  await openHash(app);
  app.stdin.emit('data', 'clean up');
  app.stdin.emit('data', '\r');
  await until(() => app.pty.written.length > 0);
  expect(app.pty.written.map(String).join('')).toBe('rm x');

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('a suggestion never writes an escape sequence to the pty', async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => reply('ls \x1b[2J') });
  const app = startApp({ load: () => LOADED, model: okModel(model) });

  await openHash(app);
  app.stdin.emit('data', 'list');
  app.stdin.emit('data', '\r');
  await until(() => app.pty.written.length > 0);
  expect(app.pty.written.map(String).join('')).toBe('ls [2J');
  expect(app.pty.written.map(String).join('')).not.toContain('\x1b');

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('hash is forwarded when the prompt is not empty', async () => {
  const app = startApp({ load: () => LOADED });

  app.pty.emit(`\x1b]133;A\x07$ \x1b]133;B\x07x`);
  await until(() => output(app.stdout).includes('$'));
  app.stdin.emit('data', '#');
  await until(() => app.pty.written.length > 0);
  expect(app.pty.written.map(String).join('')).toBe('#');

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('hash is forwarded while a command is running', async () => {
  const app = startApp({ load: () => LOADED });

  app.pty.emit(`${PROMPT}sleep\r\n\x1b]133;C\x07`);
  await until(() => output(app.stdout).includes('sleep'));
  app.stdin.emit('data', '#');
  await until(() => app.pty.written.length > 0);
  expect(app.pty.written.map(String).join('')).toBe('#');

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('hash is forwarded without integration marks', async () => {
  const app = startApp({ load: () => LOADED });

  app.stdin.emit('data', '#');
  await until(() => app.pty.written.length > 0);
  expect(app.pty.written).toEqual(['#']);

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('escape while busy aborts the request and nothing is written later', async () => {
  let answer: (value: unknown) => void = () => {};
  const model = new MockLanguageModelV4({
    doGenerate: () =>
      new Promise(resolve => {
        answer = resolve;
      }),
  });
  const app = startApp({ load: () => LOADED, model: okModel(model) });

  await openHash(app);
  app.stdin.emit('data', 'list files');
  app.stdin.emit('data', '\r');
  await until(() => model.doGenerateCalls.length === 1);
  await until(() => output(app.stdout).includes('…'));

  app.stdin.emit('data', '\x1b');
  await until(() => !output(app.stdout).includes('# list files'));
  answer(reply('rm -rf /'));
  await wait(30);
  expect(app.pty.written).toEqual([]);
  expect(output(app.stdout)).toContain('$');

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('a suggestion is dropped when the prompt is no longer idle', async () => {
  let answer: (value: unknown) => void = () => {};
  const model = new MockLanguageModelV4({
    doGenerate: () =>
      new Promise(resolve => {
        answer = resolve;
      }),
  });
  const app = startApp({ load: () => LOADED, model: okModel(model) });

  await openHash(app);
  app.stdin.emit('data', 'list files');
  app.stdin.emit('data', '\r');
  await until(() => model.doGenerateCalls.length === 1);

  app.pty.emit('y');
  await wait(30);
  answer(reply('find .'));
  await until(() => output(app.stdout).includes('prompt changed — suggestion not typed'));
  expect(app.pty.written).toEqual([]);

  app.stdin.emit('data', '\x1b');
  await until(() => !output(app.stdout).includes('prompt changed — suggestion not typed'));

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('without config the hash line shows the setup hint and nothing is written', async () => {
  let called = false;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      called = true;
      return reply('ls');
    },
  });
  const app = startApp({
    load: () => ({ ok: false, reason: 'missing', message: 'no config' }),
    model: okModel(model),
  });

  await openHash(app);
  app.stdin.emit('data', 'list');
  app.stdin.emit('data', '\r');
  await until(() => output(app.stdout).includes('Run `blockterm setup` to choose a model'));
  expect(called).toBe(false);
  expect(app.pty.written).toEqual([]);

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('a model error is shown with the api key redacted', async () => {
  const key = 'sk-secretvalue123';
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = key;
  try {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error(`boom ${key}`);
      },
    });
    const app = startApp({ load: () => LOADED, model: okModel(model) });

    await openHash(app);
    app.stdin.emit('data', 'list');
    app.stdin.emit('data', '\r');
    await until(() => output(app.stdout).includes('boom'));
    expect(output(app.stdout)).not.toContain(key);
    expect(app.pty.written).toEqual([]);

    app.pty.exit(0);
    await expect(app.run).resolves.toBe(0);
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
});

test('ctrl+k moves focus to the panel and back with the hash input kept', async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => reply('ls') });
  const app = startApp({ load: () => LOADED, model: okModel(model) });

  await openHash(app);
  app.stdin.emit('data', 'abc');
  await until(() => output(app.stdout).includes('# abc'));

  app.stdin.emit('data', '\x0b');
  await until(() => output(app.stdout).includes('agent · claude-haiku-5-5'));
  app.stdin.emit('data', 'zzz');
  await wait(20);

  app.stdin.emit('data', '\x0b');
  await until(() => output(app.stdout).includes('# abc'));
  expect(output(app.stdout)).not.toContain('# abczzz');
  expect(app.pty.written).toEqual([]);

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('a missing key shows Set <ENV> in the hash line', async () => {
  const app = startApp({
    load: () => LOADED,
    model: () => ({ ok: false, missingKeyEnv: 'ANTHROPIC_API_KEY' }),
  });

  await openHash(app);
  app.stdin.emit('data', 'list');
  app.stdin.emit('data', '\r');
  await until(() => output(app.stdout).includes('Set ANTHROPIC_API_KEY'));
  expect(output(app.stdout)).toContain('# list');

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('an error in the hash line is stripped of control characters', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error('boom \x1b[31mred\x9b');
    },
  });
  const app = startApp({ load: () => LOADED, model: okModel(model) });

  await openHash(app);
  app.stdin.emit('data', 'list');
  app.stdin.emit('data', '\r');
  await until(() => output(app.stdout).includes('boom'));
  expect(output(app.stdout)).toContain('boom [31mred');

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('hash in the full-screen view is written to the pty', async () => {
  const app = startApp({ load: () => LOADED });

  app.pty.emit('\x1b[?1049h');
  await wait(30);
  app.stdin.emit('data', '#');
  await until(() => app.pty.written.length > 0);
  expect(app.pty.written.map(String).join('')).toBe('#');

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});

test('a stale hash input does not swallow keys after the view changes', async () => {
  const app = startApp({ load: () => LOADED });

  await openHash(app);
  app.stdin.emit('data', '\x0b');
  await until(() => output(app.stdout).includes('agent · claude-haiku-5-5'));
  app.pty.emit('\x1b[?1049h');
  await wait(30);
  app.stdin.emit('data', '\x0b');
  await wait(30);

  app.stdin.emit('data', '\x03');
  await until(() => app.pty.written.map(String).join('').includes('\x03'));

  app.pty.exit(0);
  await expect(app.run).resolves.toBe(0);
});
