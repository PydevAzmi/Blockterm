import { EventEmitter } from 'node:events';

import { expect, test, vi } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';

import type { Config, LoadResult } from '../src/config.js';
import { keyHint } from '../src/agent/model.js';
import type { ModelResult } from '../src/agent/model.js';
import { runApp } from '../src/app.js';
import { TerminalSession } from '../src/term/session.js';
import { FakePty } from './helpers/fake-pty.js';

process.setMaxListeners(0);

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

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

const CONFIG: Config = {
  provider: '@ai-sdk/anthropic',
  model: 'claude-haiku-5-5',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseURL: null,
  name: null,
  shell: null,
};

const LOADED: LoadResult = { ok: true, config: CONFIG };

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
  model?: (c: Config) => ModelResult;
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

test('ctrl+k opens the panel and shows the agent title', async () => {
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(sendKeysThenDone()) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  expect(output(stdout)).toContain('agent · claude-haiku-5-5');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a submitted request reaches the model as a user message', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => model.doStreamCalls.length >= 1);
  expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('hello');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('approving the card types the keys into the pty', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('Type into'));
  stdin.emit('data', 'y');
  await until(() => pty.written.some(w => String(w).includes('echo hi\r')));
  expect(pty.written.map(String).join('')).toContain('echo hi\r');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the transcript shows the agent reply', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('Type into'));
  stdin.emit('data', 'y');
  await until(() => output(stdout).includes('done'));
  expect(output(stdout)).toContain('done');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('ctrl+k while a card is pending returns focus to the terminal', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('Type into'));

  stdin.emit('data', '\x0b');
  await wait(5);
  stdin.emit('data', 'x');
  await until(() => pty.written.some(w => String(w).includes('x')));
  expect(pty.written.map(String).join('')).toContain('x');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('ctrl+k never reaches the pty', async () => {
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(sendKeysThenDone()) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  await wait(20);
  expect(pty.written.map(String).join('')).not.toContain('\x0b');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('missing config shows the setup hint and footer status', async () => {
  const { run, pty, stdin, stdout } = startApp({
    load: () => ({ ok: false, reason: 'missing', message: 'no config' }),
    model: okModel(sendKeysThenDone()),
  });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('Run `blockterm setup` to choose a model'));
  expect(output(stdout)).toContain('run blockterm setup');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a missing key shows the hint and never calls the model', async () => {
  let called = false;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      called = true;
      return textStream('x');
    },
  });
  const factory = vi.fn((): ModelResult => ({ ok: false, missingKeyEnv: 'ANTHROPIC_API_KEY' }));
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: factory });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('Set ANTHROPIC_API_KEY'));

  for (const line of keyHint(process.platform, 'ANTHROPIC_API_KEY')) {
    expect(output(stdout)).toContain(line);
  }
  expect(output(stdout)).toContain('set ANTHROPIC_API_KEY');
  expect(factory).toHaveBeenCalledTimes(1);
  expect(called).toBe(false);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('shell exit mid-task resolves the exit code and aborts the task', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('Type into'));

  pty.exit(3);
  await expect(run).resolves.toBe(3);
  await until(() => model.doStreamCalls.at(-1)?.abortSignal?.aborted === true);
  expect(model.doStreamCalls.at(-1)?.abortSignal?.aborted).toBe(true);
});
