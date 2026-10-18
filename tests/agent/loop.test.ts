import { expect, test, vi } from 'vitest';
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

function toolResultIds(history: unknown[]): string[] {
  const ids: string[] = [];
  for (const message of history as { role: string; content: unknown }[]) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content as { type: string; toolCallId?: string }[]) {
      if (part.type === 'tool-result' && part.toolCallId) ids.push(part.toolCallId);
    }
  }
  return ids;
}

function toolCallIds(history: unknown[]): string[] {
  const ids: string[] = [];
  for (const message of history as { role: string; content: unknown }[]) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content as { type: string; toolCallId?: string }[]) {
      if (part.type === 'tool-call' && part.toolCallId) ids.push(part.toolCallId);
    }
  }
  return ids;
}

function assertHistoryComplete(history: unknown[]): void {
  const results = new Set(toolResultIds(history));
  for (const id of toolCallIds(history)) expect(results.has(id)).toBe(true);
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

  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let history: unknown[] = [];
  let errorCalls: unknown[][] = [];
  let warnCalls: unknown[][] = [];
  try {
    history = await runTask({
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
    errorCalls = errorSpy.mock.calls.map(args => [...args]);
    warnCalls = warnSpy.mock.calls.map(args => [...args]);
  } finally {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }

  const error = events.find(e => e.type === 'error');
  expect(error).toBeDefined();
  expect(error && error.type === 'error' ? error.message : '').toContain('401');
  expect(error && error.type === 'error' ? error.message : '').not.toContain('sk-secret-123');
  expect(Array.isArray(history)).toBe(true);

  const loggedSecret = [...errorCalls, ...warnCalls].some(args =>
    args.some(arg => String(arg).includes('sk-secret-123')),
  );
  expect(loggedSecret).toBe(false);
  expect(errorCalls).toEqual([]);
});

test('abort during approval leaves no dangling tool calls', async () => {
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
  const history = await running;

  expect(pty.written).toEqual([]);
  expect(history.at(-1)).toMatchObject({ role: 'tool' });
  assertHistoryComplete(history);
  const results = history.at(-1) as { content: { toolCallId: string; output: { value: { status: string } } }[] };
  expect(results.content.map(p => p.toolCallId)).toEqual(['c1']);
  expect(results.content[0]?.output.value.status).toBe('cancelled');
});

test('approve rejection leaves no dangling tool calls', async () => {
  const { pty, session, events } = harness();
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      if (n !== 1) return textStream('ok');
      const json1 = JSON.stringify({ keys: 'ls<Enter>' });
      const json2 = JSON.stringify({ keys: 'pwd<Enter>' });
      return {
        stream: convertArrayToReadableStream([
          { type: 'tool-input-start', id: 'c1', toolName: 'send_keys' },
          { type: 'tool-input-delta', id: 'c1', delta: json1 },
          { type: 'tool-input-end', id: 'c1' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'send_keys', input: json1 },
          { type: 'tool-input-start', id: 'c2', toolName: 'send_keys' },
          { type: 'tool-input-delta', id: 'c2', delta: json2 },
          { type: 'tool-input-end', id: 'c2' },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'send_keys', input: json2 },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
        ]),
      };
    },
  });

  const running = runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async () => {
      throw new Error('approval failed');
    },
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });
  const history = await running;

  expect(pty.written).toEqual([]);
  expect(history.at(-1)).toMatchObject({ role: 'tool' });
  assertHistoryComplete(history);
  const results = history.at(-1) as { content: { toolCallId: string; output: { value: { status: string; message: string } } }[] };
  expect(results.content.map(p => p.toolCallId)).toEqual(['c1', 'c2']);
  expect(results.content.map(p => p.output.value.status)).toEqual(['error', 'error']);
  expect(events).toContainEqual({ type: 'error', message: 'approval failed' });
});

test('invalid tool input is not double-reported', async () => {
  const { pty, session, events } = harness();
  const approveCalls: string[] = [];
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      if (n === 1) {
        return {
          stream: convertArrayToReadableStream([
            { type: 'tool-input-start', id: 'c1', toolName: 'send_keys' },
            { type: 'tool-input-delta', id: 'c1', delta: 'not json' },
            { type: 'tool-input-end', id: 'c1' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'send_keys', input: 'not json' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
          ]),
        };
      }
      return textStream('done');
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
      return { kind: 'approve', keys, allowRest: false };
    },
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });

  expect(approveCalls).toEqual([]);
  expect(pty.written).toEqual([]);
  expect(toolResultIds(history).filter(id => id === 'c1')).toHaveLength(1);
  assertHistoryComplete(history);
});

test('one step with read_screen and send_keys', async () => {
  const { pty, session, events } = harness();
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      if (n !== 1) return textStream('done');
      const json = JSON.stringify({ keys: 'ls<Enter>' });
      return {
        stream: convertArrayToReadableStream([
          { type: 'tool-input-start', id: 'r1', toolName: 'read_screen' },
          { type: 'tool-input-delta', id: 'r1', delta: '{}' },
          { type: 'tool-input-end', id: 'r1' },
          { type: 'tool-call', toolCallId: 'r1', toolName: 'read_screen', input: '{}' },
          { type: 'tool-input-start', id: 'c1', toolName: 'send_keys' },
          { type: 'tool-input-delta', id: 'c1', delta: json },
          { type: 'tool-input-end', id: 'c1' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'send_keys', input: json },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
        ]),
      };
    },
  });

  await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async keys => ({ kind: 'approve', keys, allowRest: false }),
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });

  expect(events).toContainEqual({ type: 'tool', name: 'read_screen' });
  expect(pty.written).toEqual(['ls\r']);
});

test('two send_keys in one step: denied first, approved second', async () => {
  const { pty, session, events } = harness();
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      if (n !== 1) return textStream('done');
      const json1 = JSON.stringify({ keys: 'a<Enter>' });
      const json2 = JSON.stringify({ keys: 'b<Enter>' });
      return {
        stream: convertArrayToReadableStream([
          { type: 'tool-input-start', id: 'c1', toolName: 'send_keys' },
          { type: 'tool-input-delta', id: 'c1', delta: json1 },
          { type: 'tool-input-end', id: 'c1' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'send_keys', input: json1 },
          { type: 'tool-input-start', id: 'c2', toolName: 'send_keys' },
          { type: 'tool-input-delta', id: 'c2', delta: json2 },
          { type: 'tool-input-end', id: 'c2' },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'send_keys', input: json2 },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
        ]),
      };
    },
  });

  const approveCalls: string[] = [];
  const history = await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async keys => {
      approveCalls.push(keys);
      if (keys === 'a<Enter>') return { kind: 'deny', reason: 'nope' };
      return { kind: 'approve', keys, allowRest: false };
    },
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });

  expect(approveCalls).toEqual(['a<Enter>', 'b<Enter>']);
  expect(pty.written).toEqual(['b\r']);
  const toolMessages = history.filter(m => m.role === 'tool');
  const withBoth = toolMessages.find(
    m => Array.isArray(m.content) && m.content.some(p => p.toolCallId === 'c1') && m.content.some(p => p.toolCallId === 'c2'),
  ) as { content: { toolCallId: string; output: { value: { status: string } } }[] };
  expect(withBoth).toBeDefined();
  expect(withBoth.content.map(p => p.toolCallId)).toEqual(['c1', 'c2']);
  expect(withBoth.content[0]?.output.value.status).toBe('denied');
  expect(withBoth.content[1]?.output.value.status).toBe('done');
});

test('edited keys that fail to parse write nothing and do not set allowRest', async () => {
  const { pty, session, events } = harness();
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      if (n === 1) return callStream('c1', 'send_keys', { keys: 'ls<Enter>' });
      if (n === 2) return callStream('c2', 'send_keys', { keys: 'a<Enter>' });
      return textStream('done');
    },
  });

  const approveCalls: string[] = [];
  const history = await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async keys => {
      approveCalls.push(keys);
      if (keys === 'ls<Enter>') return { kind: 'approve', keys: '<Foo>', allowRest: true };
      return { kind: 'approve', keys, allowRest: false };
    },
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: [],
  });

  expect(approveCalls).toEqual(['ls<Enter>', 'a<Enter>']);
  expect(pty.written).toEqual(['a\r']);
  const first = toolResultIds(history);
  expect(first).toContain('c1');
  const toolResults = history
    .filter(m => m.role === 'tool')
    .flatMap(m => (Array.isArray(m.content) ? m.content : []) as { toolCallId: string; output: { value: { status: string; message: string } } }[]);
  const c1 = toolResults.find(p => p.toolCallId === 'c1');
  expect(c1?.output.value.status).toBe('error');
  expect(c1?.output.value.message).toBe('unknown key <Foo>');
});

test('25 tool call limit leaves no dangling tool calls', async () => {
  const { session, events } = harness();
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      return callStream('c' + n, 'read_screen', {});
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
    secrets: [],
  });

  expect(events.some(e => e.type === 'limit')).toBe(true);
  assertHistoryComplete(history);
});

test('abort during allow-rest approval cancels the remaining auto-sends', async () => {
  const { pty, session, events } = harness();
  const controller = new AbortController();
  const approveCalls: string[] = [];
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      if (n !== 1) return textStream('done');
      const json1 = JSON.stringify({ keys: 'a<Enter>' });
      const json2 = JSON.stringify({ keys: 'b<Enter>' });
      return {
        stream: convertArrayToReadableStream([
          { type: 'tool-input-start', id: 'c1', toolName: 'send_keys' },
          { type: 'tool-input-delta', id: 'c1', delta: json1 },
          { type: 'tool-input-end', id: 'c1' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'send_keys', input: json1 },
          { type: 'tool-input-start', id: 'c2', toolName: 'send_keys' },
          { type: 'tool-input-delta', id: 'c2', delta: json2 },
          { type: 'tool-input-end', id: 'c2' },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'send_keys', input: json2 },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
        ]),
      };
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
      controller.abort();
      return { kind: 'approve', keys, allowRest: true };
    },
    onEvent: e => events.push(e),
    signal: controller.signal,
    secrets: [],
  });

  expect(approveCalls).toEqual(['a<Enter>']);
  expect(pty.written).toEqual([]);
  expect(events).toContainEqual({ type: 'cancelled' });
  assertHistoryComplete(history);
  const results = history.at(-1) as {
    content: { toolCallId: string; output: { value: { status: string } } }[];
  };
  expect(results.content.map(p => p.toolCallId)).toEqual(['c1', 'c2']);
  expect(results.content.map(p => p.output.value.status)).toEqual(['cancelled', 'cancelled']);
});

test('approval error stored in history is redacted', async () => {
  const { pty, session, events } = harness();
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n += 1;
      if (n !== 1) return textStream('done');
      return callStream('c1', 'send_keys', { keys: 'ls<Enter>' });
    },
  });

  const history = await runTask({
    model,
    system: 'sys',
    history: [],
    prompt: 'go',
    ctx: { session, appCursor: () => false },
    target: () => 'shell',
    approve: async () => {
      throw new Error('boom sk-secret-123');
    },
    onEvent: e => events.push(e),
    signal: new AbortController().signal,
    secrets: ['sk-secret-123'],
  });

  expect(pty.written).toEqual([]);
  expect(JSON.stringify(history)).not.toContain('sk-secret-123');
});

