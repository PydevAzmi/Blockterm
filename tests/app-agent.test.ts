import { EventEmitter } from 'node:events';

import { expect, test, vi } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';

import type { Config, LoadResult } from '../src/config.js';
import { keyHint } from '../src/agent/model.js';
import type { ModelResult } from '../src/agent/model.js';
import { runApp, cardTokens } from '../src/app.js';
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

function sendKeysModel(keys: string): MockLanguageModelV4 {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      return n === 1 ? callStream('c1', 'send_keys', { keys }) : textStream('done');
    },
  });
}

function sendKeysAfter(gate: Promise<void>): MockLanguageModelV4 {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      if (n === 1) {
        await gate;
        return callStream('c1', 'send_keys', { keys: 'echo hi<Enter>' });
      }
      return textStream('done');
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
  headers: null,
  sessionHeader: null,
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
  model?: (c: Config, sessionId?: string) => ModelResult;
  cols?: number;
  rows?: number;
}): { run: Promise<number>; pty: FakePty; stdin: FakeStdin; stdout: FakeStdout } {
  const pty = new FakePty();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(o.cols ?? 80, o.rows ?? 24);
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

test('the model factory receives a session id for the conversation', async () => {
  const model = sendKeysThenDone();
  const seen: (string | undefined)[] = [];
  const factory = (_config: Config, sessionId?: string): ModelResult => {
    seen.push(sessionId);
    return { ok: true, model, label: CONFIG.model };
  };
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: factory });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => seen.length >= 1);
  expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('approving the card types the keys into the pty', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('wants to type into'));
  await wait(450);
  stdin.emit('data', 'y');
  await until(() => pty.written.some(w => String(w).includes('echo hi\r')));
  expect(pty.written.map(String).join('')).toContain('echo hi\r');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('an approval waits for a quiet pause after the card is shown', async () => {
  vi.useFakeTimers();
  try {
    const model = sendKeysThenDone();
    const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

    stdin.emit('data', '\x0b');
    await vi.advanceTimersByTimeAsync(0);
    stdin.emit('data', 'hello\r');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(output(stdout)).toContain('wants to type into');

    for (let i = 0; i < 5; i += 1) {
      stdin.emit('data', 'y');
      await vi.advanceTimersByTimeAsync(100);
      expect(pty.written).toHaveLength(0);
    }

    await vi.advanceTimersByTimeAsync(450);
    stdin.emit('data', 'y');
    await vi.advanceTimersByTimeAsync(50);
    expect(pty.written.map(String).join('')).toContain('echo hi\r');

    pty.exit(0);
    await expect(run).resolves.toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('enter approves only after a quiet pause', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('wants to type into'));
  await wait(10);
  stdin.emit('data', '\r');
  await wait(20);
  expect(pty.written).toHaveLength(0);

  await wait(450);
  stdin.emit('data', '\r');
  await until(() => pty.written.some(w => String(w).includes('echo hi\r')));
  expect(pty.written.map(String).join('')).toContain('echo hi\r');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('enter in the same tick the card appears does not approve', async () => {
  vi.useFakeTimers();
  try {
    const model = sendKeysThenDone();
    const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

    stdin.emit('data', '\x0b');
    await vi.advanceTimersByTimeAsync(0);
    stdin.emit('data', 'hello\r');
    await vi.advanceTimersByTimeAsync(0);
    stdin.emit('data', '\r');
    await vi.advanceTimersByTimeAsync(50);
    expect(output(stdout)).toContain('wants to type into');
    expect(pty.written).toHaveLength(0);

    stdin.emit('data', '\r');
    await vi.advanceTimersByTimeAsync(10);
    expect(pty.written).toHaveLength(0);

    pty.exit(0);
    await expect(run).resolves.toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('an edit-and-enter sent right after the card is ignored', async () => {
  vi.useFakeTimers();
  try {
    const model = sendKeysThenDone();
    const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

    stdin.emit('data', '\x0b');
    await vi.advanceTimersByTimeAsync(0);
    stdin.emit('data', 'hello\r');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(output(stdout)).toContain('wants to type into');

    stdin.emit('data', 'e\r');
    await vi.advanceTimersByTimeAsync(20);
    expect(pty.written).toHaveLength(0);

    pty.exit(0);
    await expect(run).resolves.toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('type-ahead right after a card does not approve unseen keys', async () => {
  vi.useFakeTimers();
  try {
    const model = sendKeysThenDone();
    const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

    stdin.emit('data', '\x0b');
    await vi.advanceTimersByTimeAsync(0);
    stdin.emit('data', 'hello\r');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(output(stdout)).toContain('wants to type into');

    for (const ch of ['m', 'a', 'k', 'e', '\r']) {
      stdin.emit('data', ch);
      await vi.advanceTimersByTimeAsync(11);
      expect(pty.written).toHaveLength(0);
    }

    pty.exit(0);
    await expect(run).resolves.toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('a draft is cleared when the card appears and enter still approves', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const model = sendKeysAfter(gate);
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'go\r');
  await until(() => model.doStreamCalls.length >= 1);
  stdin.emit('data', 'hello');
  await wait(20);
  release();
  await until(() => output(stdout).includes('wants to type into'));
  expect(output(stdout)).not.toContain('hello');
  await wait(450);
  stdin.emit('data', '\r');
  await until(() => pty.written.some(w => String(w).includes('echo hi\r')));
  expect(pty.written.map(String).join('')).toContain('echo hi\r');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('enter does not approve after a printable key was ignored', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('wants to type into'));
  stdin.emit('data', 'x');
  await wait(20);
  await wait(450);
  stdin.emit('data', '\r');
  await wait(100);
  expect(output(stdout)).toContain('wants to type into');
  expect(pty.written).toEqual([]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('y still approves a card while a draft is already in the input', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const model = sendKeysAfter(gate);
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'go\r');
  await until(() => model.doStreamCalls.length >= 1);
  stdin.emit('data', 'hello');
  await wait(20);
  release();
  await until(() => output(stdout).includes('wants to type into'));
  await wait(450);
  stdin.emit('data', 'y');
  await until(() => pty.written.some(w => String(w).includes('echo hi\r')));
  expect(pty.written.map(String).join('')).toContain('echo hi\r');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('escape that clears a mouse highlight still resets the quiet window', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('wants to type into'));
  await wait(450);

  stdin.emit('data', '\x1b[<0;2;2M');
  stdin.emit('data', '\x1b[<32;6;2M');
  await wait(20);
  stdin.emit('data', '\x1b');
  await wait(20);
  stdin.emit('data', '\r');
  await wait(100);
  expect(output(stdout)).toContain('wants to type into');
  expect(pty.written).toEqual([]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('an edited card is approved once the field is drawn and quiet', async () => {
  vi.useFakeTimers();
  try {
    const model = sendKeysThenDone();
    const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

    stdin.emit('data', '\x0b');
    await vi.advanceTimersByTimeAsync(0);
    stdin.emit('data', 'hello\r');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(output(stdout)).toContain('wants to type into');

    await vi.advanceTimersByTimeAsync(450);
    stdin.emit('data', 'e');
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(450);
    stdin.emit('data', '\r');
    await vi.advanceTimersByTimeAsync(50);
    expect(pty.written.map(String).join('')).toContain('echo hi\r');

    pty.exit(0);
    await expect(run).resolves.toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('clear empties the transcript and starts a fresh conversation', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => textStream('first reply'),
  });
  const seen: (string | undefined)[] = [];
  const factory = (_config: Config, sessionId?: string): ModelResult => {
    seen.push(sessionId);
    return { ok: true, model, label: CONFIG.model };
  };
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: factory });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('first reply'));
  await until(() => !output(stdout).includes('agent busy'));

  stdin.emit('data', '\x0b');
  stdin.emit('data', '\x0b');
  stdin.emit('data', '/clear\r');
  await until(() => output(stdout).includes('chat cleared'));

  stdin.emit('data', 'hi\r');
  await until(() => seen.length >= 2 && model.doStreamCalls.length >= 2);

  const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
  expect(prompt).toContain('hi');
  expect(prompt).not.toContain('hello');
  expect(prompt).not.toContain('first reply');
  expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(seen[1]).toMatch(/^[0-9a-f-]{36}$/);
  expect(seen[1]).not.toBe(seen[0]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('ctrl+l while busy keeps the transcript and asks to cancel first', async () => {
  let release: (() => void) | null = null;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return textStream('late');
    },
  });
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('agent busy'));
  await until(() => release !== null);

  try {
    stdin.emit('data', '\x0c');
    await wait(50);
    const screen = output(stdout);
    expect(screen).toContain('Esc to cancel first');
    expect(screen).toContain('hello');
    expect(screen).not.toContain('chat cleared');
  } finally {
    release?.();
    pty.exit(0);
  }

  await expect(run).resolves.toBe(0);
});

test('a provider error adds a note pointing at blockterm doctor', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error('provider down');
    },
  });
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('check your model with blockterm doctor'));
  expect(output(stdout)).toContain('provider down');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the transcript shows the agent reply', async () => {
  const model = sendKeysThenDone();
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('wants to type into'));
  await wait(450);
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
  await until(() => output(stdout).includes('wants to type into'));

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

test('opening the agent line takes rows from the pty, never columns', async () => {
  const { run, pty, stdin, stdout } = startApp({
    load: () => LOADED,
    model: okModel(sendKeysThenDone()),
    cols: 90,
    rows: 30,
  });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  await until(() => pty.resizes.length >= 1);
  expect(pty.resizes).toEqual([[90, 22]]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('mouse presses are swallowed while the agent line has focus and pass once it does not', async () => {
  const { run, pty, stdin, stdout } = startApp({
    load: () => LOADED,
    model: okModel(sendKeysThenDone()),
    cols: 90,
    rows: 30,
  });

  pty.emit('\x1b[?1000h');
  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));

  stdin.emit('data', '\x1b[<0;10;5M');
  await wait(20);
  expect(pty.written).toHaveLength(0);

  stdin.emit('data', '\x0b');
  await wait(5);
  stdin.emit('data', '\x1b[<0;10;5M');
  await until(() => pty.written.length > 0);
  expect(pty.written).toHaveLength(1);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('escape closes an idle agent line', async () => {
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(sendKeysThenDone()) });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', '\x1b');
  await until(() => !output(stdout).includes('agent · claude-haiku-5-5'));

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('closing the agent line gives the rows back to the pty', async () => {
  const { run, pty, stdin, stdout } = startApp({
    load: () => LOADED,
    model: okModel(sendKeysThenDone()),
    cols: 200,
    rows: 30,
  });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  await until(() => pty.resizes.length >= 1);
  expect(pty.resizes.at(-1)).toEqual([200, 22]);

  stdin.emit('data', '\x1b');
  await until(() => pty.resizes.length >= 2);
  expect(pty.resizes.at(-1)).toEqual([200, 29]);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a throwing model factory shows a redacted error and resets to idle', async () => {
  const factory = (): ModelResult => {
    throw new Error('boom sk-secretvalue123');
  };
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: factory });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('boom'));
  expect(output(stdout)).not.toContain('sk-secretvalue123');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('invalid card keys show an invalid-keys message', () => {
  const tokens = cardTokens('echo <Foo>');
  expect(tokens).toHaveLength(1);
  expect(tokens[0]).toEqual({ kind: 'text', label: 'invalid keys: unknown key <Foo>' });
});

test('a card too long to show rejects y but approves an edit with enter', async () => {
  const keys = `echo ${'x'.repeat(80)}<Enter>`;
  const { run, pty, stdin, stdout } = startApp({
    load: () => LOADED,
    model: okModel(sendKeysModel(keys)),
    cols: 200,
    rows: 8,
  });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('too long to show'));

  stdin.emit('data', 'y');
  await wait(20);
  expect(pty.written).toHaveLength(0);

  await wait(450);
  stdin.emit('data', 'e');
  await wait(450);
  stdin.emit('data', '\r');
  await until(() => pty.written.length > 0);
  expect(pty.written.map(String).join('')).toContain('echo xxxx');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('an edit whose keys do not all fit is not approved by enter', async () => {
  const keys = `echo ${'x'.repeat(240)}<Enter>`;
  const { run, pty, stdin, stdout } = startApp({
    load: () => LOADED,
    model: okModel(sendKeysModel(keys)),
    cols: 100,
    rows: 8,
  });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('wants to type into'));
  await wait(450);
  stdin.emit('data', 'e');
  await wait(450);
  stdin.emit('data', '\r');
  await wait(50);
  expect(pty.written).toHaveLength(0);

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('the same edit fits and is approved in a wider panel', async () => {
  const keys = `echo ${'x'.repeat(240)}<Enter>`;
  const { run, pty, stdin, stdout } = startApp({
    load: () => LOADED,
    model: okModel(sendKeysModel(keys)),
    cols: 200,
    rows: 40,
  });

  stdin.emit('data', '\x0b');
  await until(() => output(stdout).includes('agent · claude-haiku-5-5'));
  stdin.emit('data', 'hello\r');
  await until(() => output(stdout).includes('wants to type into'));
  await wait(450);
  stdin.emit('data', 'e');
  await wait(450);
  stdin.emit('data', '\r');
  await until(() => pty.written.length > 0);
  expect(pty.written.map(String).join('')).toContain('echo xxxx');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('a truncated card that fits after a resize still needs a fresh quiet pause before y', async () => {
  vi.useFakeTimers();
  try {
    const keys = `echo ${'x'.repeat(80)}<Enter>`;
    const { run, pty, stdin, stdout } = startApp({
      load: () => LOADED,
      model: okModel(sendKeysModel(keys)),
      cols: 200,
      rows: 8,
    });

    stdin.emit('data', '\x0b');
    await vi.advanceTimersByTimeAsync(0);
    stdin.emit('data', 'hello\r');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(output(stdout)).toContain('too long to show');

    await vi.advanceTimersByTimeAsync(450);

    stdout.rows = 40;
    stdout.emit('resize');
    await vi.advanceTimersByTimeAsync(70);
    expect(output(stdout)).not.toContain('too long to show');

    stdin.emit('data', 'y');
    await vi.advanceTimersByTimeAsync(80);
    expect(pty.written).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(450);
    stdin.emit('data', 'y');
    await vi.advanceTimersByTimeAsync(50);
    expect(pty.written.map(String).join('')).toContain('echo xxxx');

    pty.exit(0);
    await expect(run).resolves.toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('an edit field that fits after a resize still needs a fresh quiet pause before enter', async () => {
  vi.useFakeTimers();
  try {
    const keys = `echo ${'x'.repeat(240)}<Enter>`;
    const { run, pty, stdin, stdout } = startApp({
      load: () => LOADED,
      model: okModel(sendKeysModel(keys)),
      cols: 100,
      rows: 8,
    });

    stdin.emit('data', '\x0b');
    await vi.advanceTimersByTimeAsync(0);
    stdin.emit('data', 'hello\r');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(output(stdout)).toContain('wants to type into');

    await vi.advanceTimersByTimeAsync(450);
    stdin.emit('data', 'e');
    await vi.advanceTimersByTimeAsync(50);

    await vi.advanceTimersByTimeAsync(450);

    stdout.rows = 40;
    stdout.emit('resize');
    await vi.advanceTimersByTimeAsync(70);

    stdin.emit('data', '\r');
    await vi.advanceTimersByTimeAsync(80);
    expect(pty.written).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(450);
    stdin.emit('data', '\r');
    await vi.advanceTimersByTimeAsync(50);
    expect(pty.written.map(String).join('')).toContain('echo xxxx');

    pty.exit(0);
    await expect(run).resolves.toBe(0);
  } finally {
    vi.useRealTimers();
  }
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
  await until(() => output(stdout).includes('wants to type into'));

  pty.exit(3);
  await expect(run).resolves.toBe(3);
  await until(() => model.doStreamCalls.at(-1)?.abortSignal?.aborted === true);
  expect(model.doStreamCalls.at(-1)?.abortSignal?.aborted).toBe(true);
});

test('F1 shows the help overlay, keys do not reach the pty, and Esc closes it', async () => {
  const { run, pty, stdin, stdout } = startApp({ load: () => LOADED });

  stdin.emit('data', '\x1bOP');
  await until(() => output(stdout).includes('blockterm keys'));
  stdin.emit('data', 'x');
  await wait(20);
  expect(pty.written).toHaveLength(0);

  stdin.emit('data', '\x1b');
  await until(() => !output(stdout).includes('blockterm keys'));
  stdin.emit('data', '\x1b');
  await until(() => pty.written.some(w => String(w) === '\x1b'));

  stdin.emit('data', '\x1b[11~');
  await until(() => output(stdout).includes('blockterm keys'));
  expect(output(stdout)).toContain('ctrl+k        agent line / switch focus');

  pty.exit(0);
  await expect(run).resolves.toBe(0);
});

test('closing help resets the approval gate before y counts', async () => {
  vi.useFakeTimers();
  try {
    const model = sendKeysThenDone();
    const { run, pty, stdin, stdout } = startApp({ load: () => LOADED, model: okModel(model) });

    stdin.emit('data', '\x0b');
    await vi.advanceTimersByTimeAsync(0);
    stdin.emit('data', 'hello\r');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(output(stdout)).toContain('wants to type into');
    await vi.advanceTimersByTimeAsync(450);

    stdin.emit('data', '\x1bOP');
    await vi.advanceTimersByTimeAsync(50);
    expect(output(stdout)).toContain('blockterm keys');

    stdin.emit('data', '\x1b');
    await vi.advanceTimersByTimeAsync(11);
    stdin.emit('data', 'y');
    await vi.advanceTimersByTimeAsync(50);
    expect(pty.written).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(450);
    stdin.emit('data', 'y');
    await vi.advanceTimersByTimeAsync(50);
    expect(pty.written.map(String).join('')).toContain('echo hi\r');

    pty.exit(0);
    await expect(run).resolves.toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
