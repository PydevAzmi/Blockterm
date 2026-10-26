import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';

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
  copy?: (text: string) => void;
  cols?: number;
  rows?: number;
} = {}): {
  run: Promise<number>;
  pty: FakePty;
  stdin: FakeStdin;
  stdout: FakeStdout;
} {
  const pty = new FakePty();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(o.cols ?? 80, o.rows ?? 24);
  const run = runApp({
    shell: { file: 'fake-shell', args: [] },
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    createSession: (_shell, size) => new TerminalSession(pty, size),
    loadConfig: o.load ?? (() => LOADED),
    ...(o.model !== undefined ? { modelFactory: o.model } : {}),
    ...(o.copy !== undefined ? { copy: o.copy } : {}),
  });
  return { run, pty, stdin, stdout };
}

function okModel(model: MockLanguageModelV4): (config: Config) => ModelResult {
  return () => ({ ok: true, model, label: CONFIG.model });
}

function textStream(text: string) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: text },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
    ]),
  };
}

function callStream(id: string, name: string, input: unknown) {
  const json = JSON.stringify(input);
  return {
    stream: convertArrayToReadableStream([
      { type: 'tool-input-start', id, toolName: name },
      { type: 'tool-input-delta', id, delta: json },
      { type: 'tool-input-end', id },
      { type: 'tool-call', toolCallId: id, toolName: name, input: json },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
    ]),
  };
}

function sendKeysThenDone(): MockLanguageModelV4 {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      return n === 1
        ? callStream('c1', 'send_keys', { keys: 'echo hi<Enter>' })
        : textStream('done');
    },
  });
}

function failedCycle(body = 'boom', command = 'npm test'): string {
  const prompt = '\x1b]133;A\x07$ \x1b]133;B\x07';
  return (
    `${osc7(FOLDER)}${prompt}${command}\r\n` +
    `\x1b]133;C\x07${body}\r\n\x1b]133;D;1\x07${prompt}`
  );
}

// Explain is keyboard-only now: select the newest block, then e.
function explainNewest(stdin: FakeStdin): void {
  stdin.emit('data', '\x1b[1;5A');
  stdin.emit('data', 'e');
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

function runBlock(command: string, body: string, after = true): string {
  const prompt = after ? '\x1b]133;A\x07$ \x1b]133;B\x07' : '';
  const typed = command.replace(/\r?\n/g, '\r\n');
  return (
    `${osc7(FOLDER)}\x1b]133;A\x07$ \x1b]133;B\x07${typed}\r\n` +
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
  await until(() => output(stdout).includes('$ ls ─'));
  expect(output(stdout)).toContain('$ ls ─');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the header shows the OSC 7 folder', async () => {
  const { run, pty, stdout } = startApp();

  pty.emit(`${osc7(FOLDER)}\x1b]133;A\x07$ \x1b]133;B\x07`);
  await until(() => output(stdout).includes(FOLDER));
  expect(output(stdout)).toContain(`(fake-shell) ${FOLDER}`);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('shift+PgUp scrolls up and new output shows the footer marker', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle(lines(30)));
  await until(() => output(stdout).includes('L30'));
  expect(output(stdout)).not.toContain('$ ls ─');

  stdin.emit('data', '\x1b[5;2~');
  await until(() => output(stdout).includes('$ ls ─'));
  expect(output(stdout)).not.toContain('↓ new output');

  pty.emit('more\r\n');
  await until(() => output(stdout).includes('↓ new output'));

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the wheel scrolls the blocks and never reaches the pty', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle(lines(30)));
  await until(() => output(stdout).includes('L30'));
  expect(output(stdout)).not.toContain('$ ls ─');

  for (let i = 0; i < 4; i += 1) stdin.emit('data', '\x1b[<64;5;5M');
  await until(() => output(stdout).includes('$ ls ─'));
  expect(pty.written).toEqual([]);
  expect(stdout.writes.join('')).toContain('\x1b[?1002h');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the wheel in fullscreen without mouse tracking sends arrows to the pty', async () => {
  const { run, pty, stdin } = startApp();

  pty.emit('\x1b[?1049h');
  await wait(30);

  stdin.emit('data', '\x1b[<64;5;5M');
  await until(() => pty.written.length > 0);
  expect(pty.written.map(String).join('')).toBe('\x1b[A\x1b[A\x1b[A');

  stdin.emit('data', '\x1b[<65;5;5M');
  await until(() => pty.written.map(String).join('').endsWith('\x1b[B\x1b[B\x1b[B'));
  expect(pty.written.map(String).join('')).toBe('\x1b[A\x1b[A\x1b[A\x1b[B\x1b[B\x1b[B');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the wheel in fullscreen uses application cursor arrows when enabled', async () => {
  const { run, pty, stdin } = startApp();

  pty.emit('\x1b[?1049h\x1b[?1h');
  await wait(30);

  stdin.emit('data', '\x1b[<64;5;5M');
  await until(() => pty.written.length > 0);
  expect(pty.written.map(String).join('')).toBe('\x1bOA\x1bOA\x1bOA');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the wheel in a raw shell view sends arrows to the pty', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit('hello');
  await until(() => output(stdout).includes('hello'));

  stdin.emit('data', '\x1b[<64;5;5M');
  await until(() => pty.written.length > 0);
  expect(pty.written.map(String).join('')).toBe('\x1b[A\x1b[A\x1b[A');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the wheel over the shell sends no arrows while the panel has focus', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit('\x1b[?1049h');
  await wait(30);
  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));

  stdin.emit('data', '\x1b[<64;5;5M');
  await wait(50);
  expect(pty.written).toEqual([]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the wheel over the agent strip scrolls the transcript, not the blocks', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => reply(Array.from({ length: 12 }, (_, i) => `R${String(i).padStart(2, '0')}`).join('\n')),
  });
  const { run, pty, stdin, stdout } = startApp({ model: okModel(model) });

  pty.emit(failedCycle('Error: boom'));
  await until(() => output(stdout).includes('$ npm test ─'));
  stdin.emit('data', '\x1b[1;5A');
  stdin.emit('data', 'e');
  await until(() => output(stdout).includes('R11'));
  const strip = renderScreen(stdout).findIndex(row => row.includes('R11'));
  expect(output(stdout)).not.toContain('R00');

  for (let i = 0; i < 4; i += 1) stdin.emit('data', `\x1b[<64;5;${strip + 1}M`);
  await until(() => output(stdout).includes('R00'));
  expect(pty.written).toEqual([]);

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
  expect(output(stdout)).toContain('$ ls ─');
  expect(output(stdout)).not.toContain('L30');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('ctrl+l at an idle prompt clears blocks without reaching the pty', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle('a'));
  await until(() => output(stdout).includes('$ ls ─'));
  pty.emit('\x1b]133;A\x07$ \x1b]133;B\x07');
  await wait(30);

  stdin.emit('data', '\x0c');
  await until(() => !output(stdout).includes('$ ls ─'));
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

test('a stray wheel event never reaches the pty when the program did not ask for mouse', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle(lines(30)));
  await until(() => output(stdout).includes('L30'));

  stdin.emit('data', '\x1b[<68;5;5M');
  await wait(50);
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

  pty.emit(cycle(lines(30)));
  await until(() => output(stdout).includes('L30'));
  stdin.emit('data', '\x1b[5;2~');
  await until(() => output(stdout).includes('$ ls ─'));

  stdin.emit('data', 'x');
  await until(() => !output(stdout).includes('$ ls ─'));
  expect(output(stdout)).toContain('L30');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('new output while scrolled up keeps the same rows in place', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle(lines(30)));
  await until(() => output(stdout).includes('L30'));

  stdin.emit('data', '\x1b[5;2~');
  await until(() => output(stdout).includes('$ ls ─'));
  const before = renderScreen(stdout);
  const index = before.findIndex(row => row.includes('L10'));
  expect(index).toBeGreaterThan(0);

  pty.emit('more\r\nmore2\r\n');
  await until(() => output(stdout).includes('↓ new output'));
  await until(() => (renderScreen(stdout)[index] ?? '').includes('L10'));
  const after = renderScreen(stdout);
  expect(after[index]).toContain('L10');

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

test('ctrl+up then e opens the agent line and explains the failed block', async () => {
  let release: (value: unknown) => void = () => {};
  const model = new MockLanguageModelV4({
    doGenerate: () =>
      new Promise(resolve => {
        release = resolve;
      }),
  });
  const { run, pty, stdin, stdout } = startApp({ model: okModel(model) });

  pty.emit(failedCycle('Error: boom'));
  await until(() => output(stdout).includes('$ npm test ─'));
  expect(output(stdout)).not.toContain('agent · claude-haiku-5-5');

  explainNewest(stdin);
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
  await until(() => output(stdout).includes('$ npm test ─'));

  explainNewest(stdin);
  await until(() => model.doGenerateCalls.length === 1);
  await until(() => output(stdout).includes('agent busy'));

  stdin.emit('data', '\x1b');
  await until(() => output(stdout).includes('cancelled'));
  expect(output(stdout)).not.toContain('agent busy');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('explaining while an agent task is busy does nothing', async () => {
  const model = new MockLanguageModelV4({
    doStream: () => new Promise(() => {}),
    doGenerate: async () => reply('should not happen'),
  });
  const { run, pty, stdin, stdout } = startApp({ model: okModel(model) });

  pty.emit(failedCycle('Error: boom'));
  await until(() => output(stdout).includes('$ npm test ─'));

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('hello'));
  await until(() => output(stdout).includes('agent busy'));

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('$ npm test ─'));
  explainNewest(stdin);
  await wait(50);

  expect(model.doGenerateCalls).toHaveLength(0);
  expect(output(stdout)).toContain('agent busy');

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
  await until(() => output(stdout).includes('$ npm test ─'));

  explainNewest(stdin);
  await until(() => output(stdout).includes('Run `blockterm setup` to choose a model'));
  expect(model.doGenerateCalls).toHaveLength(0);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('ctrl+up selects the newest block and ctrl+up again walks older', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(runBlock('first', lines(8)));
  pty.emit(runBlock('second', 'x'));
  await until(() => output(stdout).includes('$ second ─'));
  expect(output(stdout)).not.toContain('c copy · o output · r rerun · e explain · Esc back');

  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy · o output · r rerun · e explain · Esc back'));
  expect(pty.written).toEqual([]);
  expect(stdout.writes.join('')).toContain('\x1b[0;1;7;36m');

  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('$ first ─'));
  expect(pty.written).toEqual([]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('selecting an older block scrolls it into view', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(runBlock('first', lines(12)));
  pty.emit(runBlock('second', lines(12)));
  await until(() => output(stdout).includes('$ second ─'));
  expect(output(stdout)).not.toContain('$ first ─');

  stdin.emit('data', '\x1b[1;5A');
  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('$ first ─'));

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('revealing a block taller than the viewport settles in one scroll', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(runBlock('tall', lines(40)));
  await until(() => output(stdout).includes('L40'));
  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));

  await wait(120);
  const writes = stdout.writes.length;
  const screen = output(stdout);
  await wait(150);

  expect(stdout.writes.length).toBe(writes);
  expect(output(stdout)).toBe(screen);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('manual scrolling after a reveal is not undone by later renders', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(runBlock('first', lines(12)));
  pty.emit(runBlock('tall', lines(40)));
  pty.emit(runBlock('newest', 'x'));
  await until(() => output(stdout).includes('$ newest ─'));

  stdin.emit('data', '\x1b[1;5A');
  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));
  await wait(120);
  expect(output(stdout)).not.toContain('$ first ─');

  stdin.emit('data', '\x1b[5~');
  await wait(100);
  expect(output(stdout)).toContain('$ first ─');
  const pageWrites = stdout.writes.length;
  const afterPage = output(stdout);
  await wait(150);
  expect(stdout.writes.length).toBe(pageWrites);
  expect(output(stdout)).toBe(afterPage);

  stdin.emit('data', '\x1b[F');
  await wait(100);
  expect(output(stdout)).toContain('$ newest ─');

  stdin.emit('data', '\x1b[H');
  await wait(100);
  expect(output(stdout)).toContain('$ first ─');
  const homeWrites = stdout.writes.length;
  const afterHome = output(stdout);
  await wait(150);
  expect(stdout.writes.length).toBe(homeWrites);
  expect(output(stdout)).toBe(afterHome);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});


test('c copies the command and o copies the output', async () => {
  const copied: string[] = [];
  const { run, pty, stdin, stdout } = startApp({ copy: text => copied.push(text) });

  pty.emit(cycle('a\r\nb'));
  pty.emit(failedCycle('boom', 'false'));
  await until(() => output(stdout).includes('$ false ─'));

  stdin.emit('data', '\x1b[1;5A');
  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));

  stdin.emit('data', 'c');
  stdin.emit('data', 'o');
  await until(() => copied.length === 2);
  expect(copied).toEqual(['ls', 'a\nb']);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('c and o show copied in the footer for two seconds', async () => {
  const copied: string[] = [];
  const { run, pty, stdin, stdout } = startApp({ copy: text => copied.push(text) });

  pty.emit(cycle('a\r\nb'));
  await until(() => output(stdout).includes('$ ls ─'));

  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));

  stdin.emit('data', 'c');
  await until(() => output(stdout).includes('copied'));
  await wait(1000);
  expect(output(stdout)).toContain('copied');

  stdin.emit('data', 'o');
  await until(() => copied.length === 2);
  await wait(2200);
  expect(output(stdout)).not.toContain('copied');
  expect(output(stdout)).toContain('c copy');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('e explains the selected failed block', async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => reply('Cause: boom.') });
  const { run, pty, stdin, stdout } = startApp({ model: okModel(model) });

  pty.emit(cycle('a'));
  pty.emit(failedCycle('Error: boom'));
  await until(() => output(stdout).includes('$ npm test ─'));

  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));
  stdin.emit('data', 'e');
  await until(() => output(stdout).includes('Explain error: $ npm test (exit 1)'));
  await until(() => output(stdout).includes('Cause: boom.'));
  expect(model.doGenerateCalls).toHaveLength(1);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('e on a successful block shows nothing to explain for two seconds', async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => reply('nope') });
  const { run, pty, stdin, stdout } = startApp({ model: okModel(model) });

  pty.emit(cycle('a'));
  await until(() => output(stdout).includes('$ ls ─'));

  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));
  stdin.emit('data', 'e');
  await until(() => output(stdout).includes('nothing to explain'));
  await wait(1000);
  expect(output(stdout)).toContain('nothing to explain');
  expect(model.doGenerateCalls).toHaveLength(0);

  await wait(1200);
  expect(output(stdout)).not.toContain('nothing to explain');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('r reruns the selected command and exits selection', async () => {

  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle('a'));
  pty.emit(failedCycle('boom', 'false'));
  await until(() => output(stdout).includes('$ false ─'));

  stdin.emit('data', '\x1b[1;5A');
  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));
  stdin.emit('data', 'r');
  await until(() => pty.written.map(String).join('').includes('ls\r'));
  await until(() => !output(stdout).includes('c copy'));

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('r at a non-idle prompt writes nothing and shows the notice', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle('a'));
  pty.emit('\x1b]133;A\x07$ \x1b]133;B\x07sleep\r\n\x1b]133;C\x07');
  await until(() => output(stdout).includes('sleep'));

  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));
  stdin.emit('data', 'r');
  await until(() => output(stdout).includes('not at an idle prompt'));
  expect(pty.written).toEqual([]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a selection notice does not hide an approval pending status', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({ model: okModel(model) });

  pty.emit(cycle('a'));
  await until(() => output(stdout).includes('$ ls ─'));

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('wants to type into'));

  pty.emit('\x1b]133;A\x07$ \x1b]133;B\x07sleep\r\n\x1b]133;C\x07');
  await wait(30);

  stdin.emit('data', '\x0b');
  await wait(20);
  stdin.emit('data', '\x1b[1;5A');
  await wait(30);
  stdin.emit('data', 'r');
  await wait(50);
  expect(pty.written).toEqual([]);
  expect(output(stdout)).toContain('approval pending (ctrl+k)');
  expect(output(stdout)).not.toContain('not at an idle prompt');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('Enter and Esc leave selection without writing, a second Esc reaches the pty', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle('a'));
  await until(() => output(stdout).includes('$ ls ─'));

  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));
  stdin.emit('data', '\r');
  await until(() => !output(stdout).includes('c copy'));
  expect(pty.written).toEqual([]);

  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));
  stdin.emit('data', '\x1b');
  await until(() => !output(stdout).includes('c copy'));
  await wait(30);
  expect(pty.written).toEqual([]);

  stdin.emit('data', '\x1b');
  await until(() => pty.written.map(String).join('').includes('\x1b'));

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('r on a multi-line command uses bracketed paste when enabled', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit('\x1b[?2004h');
  pty.emit(runBlock('echo a\necho b', 'a\r\nb'));
  await until(() => output(stdout).includes('$ echo a echo b ─'));

  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));
  stdin.emit('data', 'r');
  await until(() => pty.written.length > 0);
  expect(pty.written.map(String).join('')).toBe('\x1b[200~echo a\necho b\x1b[201~\r');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('r on a multi-line command refuses without bracketed paste', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit('\x1b[?2004l');
  pty.emit(runBlock('echo a\necho b', 'a\r\nb'));
  await until(() => output(stdout).includes('$ echo a echo b ─'));

  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));
  stdin.emit('data', 'r');
  await until(() => output(stdout).includes('multi-line rerun needs bracketed paste'));
  expect(pty.written).toEqual([]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a single-line rerun writes the command and Enter when bracketed paste is enabled', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit('\x1b[?2004h');
  pty.emit(cycle('a'));
  await until(() => output(stdout).includes('$ ls ─'));

  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));
  stdin.emit('data', 'r');
  await until(() => pty.written.length > 0);
  expect(pty.written.map(String).join('')).toBe('ls\r');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('selection clears when the block cap drops the selected block', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle('a'));
  await until(() => output(stdout).includes('$ ls ─'));
  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));

  let burst = '';
  for (let i = 0; i < 200; i += 1) burst += runBlock(`cmd${i}`, 'x');
  pty.emit(burst);
  await until(() => !output(stdout).includes('c copy'), 10000);
  await until(() => output(stdout).includes('F1 help'), 2000);
  expect(output(stdout)).toContain('F1 help');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});


test('selection survives new blocks arriving', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle('a'));
  await until(() => output(stdout).includes('$ ls ─'));
  stdin.emit('data', '\x1b[1;5A');
  await until(() => output(stdout).includes('c copy'));

  pty.emit(runBlock('later', 'x'));
  await until(() => output(stdout).includes('$ later ─'));
  expect(output(stdout)).toContain('c copy');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('ctrl+down with nothing selected passes through to the pty', async () => {
  const { run, pty, stdin, stdout } = startApp();

  pty.emit(cycle('a'));
  await until(() => output(stdout).includes('$ ls ─'));

  stdin.emit('data', '\x1b[1;5B');
  await until(() => pty.written.length > 0);
  expect(pty.written).toEqual(['\x1b[1;5B']);
  expect(output(stdout)).not.toContain('c copy');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('ctrl+arrows pass through without integration, in fullscreen and with no blocks', async () => {
  const plain = startApp();
  plain.stdin.emit('data', '\x1b[1;5A');
  await until(() => plain.pty.written.length > 0);
  expect(plain.pty.written).toEqual(['\x1b[1;5A']);
  plain.pty.exit(0);
  await expect(plain.run).resolves.toBe(0);

  const full = startApp();
  full.pty.emit('\x1b[?1049h');
  await wait(30);
  full.stdin.emit('data', '\x1b[1;5B');
  await until(() => full.pty.written.length > 0);
  expect(full.pty.written).toEqual(['\x1b[1;5B']);
  full.pty.exit(0);
  await expect(full.run).resolves.toBe(0);

  const empty = startApp();
  empty.pty.emit('\x1b]133;A\x07$ \x1b]133;B\x07');
  await wait(30);
  empty.stdin.emit('data', '\x1b[1;5A');
  await until(() => empty.pty.written.length > 0);
  expect(empty.pty.written).toEqual(['\x1b[1;5A']);
  empty.pty.exit(0);
  await expect(empty.run).resolves.toBe(0);
});

test('a drag in the shell copies the selected text and shows the footer notice', async () => {
  const copied: string[] = [];
  const { run, pty, stdin, stdout } = startApp({ copy: text => copied.push(text) });

  pty.emit('hello');
  await until(() => output(stdout).includes('hello'));

  stdin.emit('data', '\x1b[<0;1;1M');
  stdin.emit('data', '\x1b[<32;5;1M');
  stdin.emit('data', '\x1b[<0;5;1m');

  await until(() => copied.length === 1);
  expect(copied).toEqual(['hello']);
  await until(() => output(stdout).includes('copied 5 chars'));

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a press and release on the same cell does not copy or leave a selection', async () => {
  const copied: string[] = [];
  const { run, pty, stdin, stdout } = startApp({ copy: text => copied.push(text) });

  pty.emit('hello');
  await until(() => output(stdout).includes('hello'));

  stdin.emit('data', '\x1b[<0;2;2M');
  stdin.emit('data', '\x1b[<0;2;2m');
  await wait(50);
  expect(copied).toEqual([]);

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));

  const beforeClick = stdout.writes.join('').length;
  stdin.emit('data', '\x1b[<0;2;2M');
  stdin.emit('data', '\x1b[<0;2;2m');
  await wait(50);
  expect(stdout.writes.join('').slice(beforeClick)).not.toContain('\x1b[0;7m');

  stdin.emit('data', '\x1b');
  await until(() => !output(stdout).includes('agent · claude-haiku-5-5'));

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a drag reaches the pty when the program asked for the mouse, and the agent strip still copies', async () => {
  const copied: string[] = [];
  const { run, pty, stdin, stdout } = startApp({ copy: text => copied.push(text) });

  pty.emit('hello');
  await until(() => output(stdout).includes('hello'));
  pty.emit('\x1b[?1000h\x1b[?1006h');
  await wait(30);

  stdin.emit('data', '\x1b[<0;1;1M');
  stdin.emit('data', '\x1b[<32;5;1M');
  stdin.emit('data', '\x1b[<0;5;1m');
  await until(() => pty.written.length >= 2);
  expect(pty.written.map(String).join('')).toContain('\x1b[<0;1;1M');
  expect(copied).toEqual([]);

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));

  stdin.emit('data', '\x1b[<0;1;24M');
  stdin.emit('data', '\x1b[<32;10;24M');
  stdin.emit('data', '\x1b[<0;10;24m');
  await until(() => copied.length === 1);
  expect(copied[0]).toContain('(agent');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a shell press after a copy does not turn its release into a second copy', async () => {
  const copied: string[] = [];
  const { run, pty, stdin, stdout } = startApp({ copy: text => copied.push(text) });

  pty.emit('hello');
  await until(() => output(stdout).includes('hello'));

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', '\x0b');
  await wait(20);
  stdin.emit('data', '\x1b[<0;1;24M');
  stdin.emit('data', '\x1b[<32;10;24M');
  stdin.emit('data', '\x1b[<0;10;24m');
  await until(() => copied.length === 1);

  pty.emit('\x1b[?1000h\x1b[?1006h');
  await wait(30);

  stdin.emit('data', '\x1b[<0;1;1M');
  stdin.emit('data', '\x1b[<0;1;1m');
  await until(() => pty.written.map(String).join('').includes('\x1b[<0;1;1m'));
  const sent = pty.written.map(String).join('');
  expect(sent).toContain('\x1b[<0;1;1M');
  expect(sent).toContain('\x1b[<0;1;1m');
  await wait(50);
  expect(copied).toHaveLength(1);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a release outside the pane copies the clamped text', async () => {
  const copied: string[] = [];
  const { run, pty, stdin, stdout } = startApp({ copy: text => copied.push(text) });

  pty.emit('hello');
  await until(() => output(stdout).includes('hello'));

  stdin.emit('data', '\x1b[<0;1;1M');
  stdin.emit('data', '\x1b[<32;200;40M');
  stdin.emit('data', '\x1b[<0;200;40m');

  await until(() => copied.length === 1);
  expect(copied[0]!.startsWith('hello')).toBe(true);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a layout change mid-drag clears the selection so the release does not copy', async () => {
  const copied: string[] = [];
  const { run, pty, stdin, stdout } = startApp({ copy: text => copied.push(text) });

  pty.emit('hello');
  await until(() => output(stdout).includes('hello'));

  stdin.emit('data', '\x1b[<0;1;1M');
  stdin.emit('data', '\x1b[<32;5;1M');
  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));

  stdin.emit('data', '\x1b[<0;5;1m');
  await wait(50);
  expect(copied).toEqual([]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('esc clears a selection over the card, and a second esc denies it', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({
    load: () => LOADED,
    model: okModel(model),
    copy: () => {},
  });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('wants to type into'));
  await wait(450);

  stdin.emit('data', '\x1b[<0;1;19M');
  stdin.emit('data', '\x1b[<32;10;19M');
  stdin.emit('data', '\x1b[<0;10;19m');
  await wait(50);

  stdin.emit('data', '\x1b');
  await wait(50);
  expect(output(stdout)).toContain('wants to type into');

  stdin.emit('data', '\x1b');
  await until(() => !output(stdout).includes('wants to type into'));
  expect(pty.written.map(String).join('')).not.toContain('echo hi');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a drag does not copy while help is open', async () => {
  const copied: string[] = [];
  const { run, pty, stdin, stdout } = startApp({ copy: text => copied.push(text) });

  pty.emit('hello');
  await until(() => output(stdout).includes('hello'));
  stdin.emit('data', '\x1bOP');
  await until(() => output(stdout).includes('blockterm keys'));

  stdin.emit('data', '\x1b[<0;1;1M');
  stdin.emit('data', '\x1b[<32;5;1M');
  stdin.emit('data', '\x1b[<0;5;1m');
  await wait(50);
  expect(copied).toEqual([]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

