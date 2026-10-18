import { expect, test } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';

import type { Decision, AgentEvent } from '../../src/agent/loop.js';
import { runTask } from '../../src/agent/loop.js';
import { TerminalSession } from '../../src/term/session.js';
import { FakePty } from '../helpers/fake-pty.js';

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

function harness() {
  const pty = new FakePty();
  const session = new TerminalSession(pty, { cols: 80, rows: 24 });
  const events: AgentEvent[] = [];
  return { pty, session, events };
}

function lastPrompt(model: MockLanguageModelV4): string {
  return JSON.stringify(model.doStreamCalls.at(-1)?.prompt ?? []);
}

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

const okDecision: Decision = { kind: 'approve', keys: '', allowRest: false };

test('read tools run without approval', async () => {
  const { pty, session, events } = harness();
  const approveCalls: string[] = [];
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      return n === 1 ? callStream('c1', 'read_screen', {}) : textStream('all done');
    },
  });

  const history = await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async keys => {
      approveCalls.push(keys);
      return { kind: 'deny', reason: 'x' };
    },
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });

  expect(approveCalls).toEqual([]);
  expect(pty.written).toEqual([]);
  expect(events).toContainEqual({ type: 'tool', name: 'read_screen' });
  const toolIndex = events.findIndex(e => e.type === 'tool');
  const textIndex = events.findIndex(e => e.type === 'text');
  expect(toolIndex).toBeGreaterThanOrEqual(0);
  expect(textIndex).toBeGreaterThan(toolIndex);
  expect(events).toContainEqual({ type: 'text', delta: 'all done' });
  expect(events.at(-1)).toEqual({ type: 'done' });
  expect(history.at(-1)).toMatchObject({ role: 'assistant' });
});

test('send_keys waits for approval', async () => {
  const { pty, session, events } = harness();
  const approveCalls: string[] = [];
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      return n === 1 ? callStream('c1', 'send_keys', { keys: 'ls<Enter>' }) : textStream('ok');
    },
  });

  await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async keys => {
      approveCalls.push(keys);
      return { kind: 'approve', keys, allowRest: false };
    },
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });

  expect(approveCalls).toEqual(['ls<Enter>']);
  expect(pty.written.at(-1)).toBe('ls\r');
  expect(events).toContainEqual({ type: 'approval', keys: 'ls<Enter>', target: 'shell' });
  expect(events).toContainEqual({ type: 'sent', keys: 'ls<Enter>', auto: false });
  expect(lastPrompt(model)).toContain('"status":"done"');
});

test('edited keys are what get sent', async () => {
  const { pty, session, events } = harness();
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      return n === 1 ? callStream('c1', 'send_keys', { keys: 'ls<Enter>' }) : textStream('ok');
    },
  });

  await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async () => ({ kind: 'approve', keys: 'pwd<Enter>', allowRest: false }),
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });

  expect(pty.written.at(-1)).toBe('pwd\r');
  const prompt = lastPrompt(model);
  expect(prompt).toContain('"edited":true');
  expect(prompt).toContain('pwd\\r');
});

test('denial reason reaches the model', async () => {
  const { pty, session, events } = harness();
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      return n === 1 ? callStream('c1', 'send_keys', { keys: 'rm -rf<Enter>' }) : textStream('ok');
    },
  });

  await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async () => ({ kind: 'deny', reason: 'not on prod' }),
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });

  expect(pty.written).toEqual([]);
  const prompt = lastPrompt(model);
  expect(prompt).toContain('"status":"denied"');
  expect(prompt).toContain('"reason":"not on prod"');
});

test('allow for this task', async () => {
  const { pty, session, events } = harness();
  const approveCalls: string[] = [];
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      if (n === 1) return callStream('c1', 'send_keys', { keys: 'a<Enter>' });
      if (n === 2) return callStream('c2', 'send_keys', { keys: 'b<Enter>' });
      return textStream('ok');
    },
  });

  await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async keys => {
      approveCalls.push(keys);
      return { kind: 'approve', keys, allowRest: true };
    },
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });

  expect(approveCalls).toEqual(['a<Enter>']);
  expect(pty.written).toEqual(['a\r', 'b\r']);
  expect(events).toContainEqual({ type: 'sent', keys: 'b<Enter>', auto: true });

  let m = 0;
  const model2 = new MockLanguageModelV4({
    doStream: async () => {
      m += 1;
      return m === 1 ? callStream('c3', 'send_keys', { keys: 'c<Enter>' }) : textStream('ok');
    },
  });
  const approveCalls2: string[] = [];
  await runTask({
    model: model2,
    system: 'sys',
    history: [],
    prompt: 'go again',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async keys => {
      approveCalls2.push(keys);
      return { kind: 'approve', keys, allowRest: false };
    },
    onEvent: () => {},
    signal: new AbortController().signal,
    secrets: [],
  });
  expect(approveCalls2).toEqual(['c<Enter>']);
});

test('malformed keys', async () => {
  const { pty, session, events } = harness();
  const approveCalls: string[] = [];
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      return n === 1 ? callStream('c1', 'send_keys', { keys: '<Foo>' }) : textStream('ok');
    },
  });

  await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async keys => {
      approveCalls.push(keys);
      return okDecision;
    },
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });

  expect(approveCalls).toEqual([]);
  expect(pty.written).toEqual([]);
  const prompt = lastPrompt(model);
  expect(prompt).toContain('"status":"error"');
  expect(prompt).toContain('unknown key <Foo>');
});

test('abort cancels', async () => {
  const { pty, session, events } = harness();
  const controller = new AbortController();
  let approveCalled = false;
  const model = new MockLanguageModelV4({
    doStream: async () => callStream('c1', 'send_keys', { keys: 'ls<Enter>' }),
  });

  const running = runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: () => {
      approveCalled = true;
      return new Promise<Decision>(() => {});
    },
    onEvent: e => events.push(e),
    signal: controller.signal,
    secrets: [],
  });

  await until(() => approveCalled);
  controller.abort();
  await running;

  expect(pty.written).toEqual([]);
  expect(events).toContainEqual({ type: 'cancelled' });
  expect(events.some(e => e.type === 'sent')).toBe(false);
});

test('25 tool call limit', async () => {
  const { session, events } = harness();
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      return callStream('c' + n, 'read_screen', {});
    },
  });

  await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async () => okDecision,
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });

  const limit = events.find(e => e.type === 'limit');
  expect(limit).toEqual({ type: 'limit', message: 'stopped: 25 tool calls' });
  expect(model.doStreamCalls.length).toBe(25);
});

test('10 minute limit', async () => {
  const { session, events } = harness();
  let elapsed = 0;
  const now = () => elapsed;
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      return callStream('c' + n, 'send_keys', { keys: 'ls<Enter>' });
    },
  });

  await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async keys => {
      elapsed = 11 * 60 * 1000;
      return { kind: 'approve', keys, allowRest: false };
    },
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
    now,
  });

  expect(events).toContainEqual({ type: 'limit', message: 'stopped: 10 minute limit' });
  expect(model.doStreamCalls.length).toBe(1);
});

test('provider error', async () => {
  const { session, events } = harness();
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error('401 invalid x-api-key sk-secret-123');
    },
  });

  const history = await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async () => okDecision,
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: ['sk-secret-123'],
  });

  const error = events.find(e => e.type === 'error');
  expect(error).toBeDefined();
  expect(error && error.type === 'error' ? error.message : '').toContain('401');
  expect(error && error.type === 'error' ? error.message : '').not.toContain('sk-secret-123');
  expect(Array.isArray(history)).toBe(true);
});
