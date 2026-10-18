import { generateText } from 'ai';
import type { LanguageModel } from 'ai';

import { expect, test } from 'vitest';

import type { Config } from '../../src/config.js';
import { createModel, keyHint, redact } from '../../src/agent/model.js';

function meta(model: LanguageModel): { modelId?: string; provider?: string } {
  return model as { modelId?: string; provider?: string };
}

const anthropic: Config = {
  provider: '@ai-sdk/anthropic',
  model: 'claude-haiku-5-5',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseURL: null,
  name: null,
  shell: null,
  headers: null,
  sessionHeader: null,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function textCompletion(): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'local-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function spyFetch(seen: Record<string, string>[]): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return jsonResponse(textCompletion());
  }) as typeof fetch;
}

function openaiCompatible(over: Partial<Config> = {}): Config {
  return {
    provider: '@ai-sdk/openai-compatible',
    model: 'local-model',
    apiKeyEnv: '',
    baseURL: 'http://localhost:1234/v1',
    name: 'local',
    shell: null,
    headers: null,
    sessionHeader: null,
    ...over,
  };
}

test('createModel: anthropic returns a model for the configured id', () => {
  const result = createModel(anthropic, { ANTHROPIC_API_KEY: 'key' });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.label).toBe('claude-haiku-5-5');
  expect(meta(result.model).modelId).toBe('claude-haiku-5-5');
  expect(meta(result.model).provider).toContain('anthropic');
});

test('createModel: openai returns an openai provider', () => {
  const config: Config = { ...anthropic, provider: '@ai-sdk/openai', model: 'gpt-4o', apiKeyEnv: 'OPENAI_API_KEY' };
  const result = createModel(config, { OPENAI_API_KEY: 'key' });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(meta(result.model).provider).toContain('openai');
});

test('createModel: openai-compatible uses the configured name', () => {
  const result = createModel(openaiCompatible(), {});
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(meta(result.model).provider?.startsWith('local')).toBe(true);
});

test('createModel: sends static headers and the configured session header', async () => {
  const seen: Record<string, string>[] = [];
  const config = openaiCompatible({
    headers: { 'X-App': 'blockterm' },
    sessionHeader: 'x-opencode-session',
  });
  const result = createModel(config, {}, { sessionId: 'sess-123', fetch: spyFetch(seen) });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  await generateText({ model: result.model, prompt: 'hi' });

  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    'x-app': 'blockterm',
    'x-opencode-session': 'sess-123',
  });
});

test('createModel: generates a session id when none is given', async () => {
  const seen: Record<string, string>[] = [];
  const config = openaiCompatible({ sessionHeader: 'x-opencode-session' });
  const result = createModel(config, {}, { fetch: spyFetch(seen) });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  await generateText({ model: result.model, prompt: 'hi' });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
});

test('createModel: sends no custom headers when none are configured', async () => {
  const seen: Record<string, string>[] = [];
  const result = createModel(openaiCompatible(), {}, { fetch: spyFetch(seen) });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  await generateText({ model: result.model, prompt: 'hi' });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.['x-opencode-session']).toBeUndefined();
  expect(seen[0]?.['x-app']).toBeUndefined();
});

test('createModel: missing key reports the env var', () => {
  expect(createModel(anthropic, {})).toEqual({ ok: false, missingKeyEnv: 'ANTHROPIC_API_KEY' });
});

test('createModel: empty key is treated as missing', () => {
  expect(createModel(anthropic, { ANTHROPIC_API_KEY: '' })).toEqual({
    ok: false,
    missingKeyEnv: 'ANTHROPIC_API_KEY',
  });
});

test('keyHint: win32 uses setx', () =>
  expect(keyHint('win32', 'X')).toEqual(['setx X "<your key>"', 'then open a new terminal']));

test('keyHint: linux uses export', () =>
  expect(keyHint('linux', 'X')).toEqual([
    'export X="<your key>"',
    'add it to ~/.bashrc or ~/.zshrc to keep it',
  ]));

test('redact: replaces a known secret with ***', () =>
  expect(redact('bad key sk-secret-123 here', ['sk-secret-123'])).toBe('bad key *** here'));

test('redact: scrubs sk- tokens even without a known secret', () => {
  const out = redact('Incorrect API key provided: sk-proj-abcdEFGH1234', []);
  expect(out).not.toContain('abcdEFGH1234');
  expect(out).toContain('***');
});

test('redact: ignores an empty secret', () =>
  expect(redact('nothing to hide', [''])).toBe('nothing to hide'));

test('redact: a sk- run inside a word is not treated as a token', () =>
  expect(redact('task-runner-xyzabc', [])).toBe('task-runner-xyzabc'));

test('ModelResult never leaks the key', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-secret-123' };
  const results = [
    createModel(anthropic, env),
    createModel({ ...anthropic, apiKeyEnv: 'OTHER_KEY' }, env),
  ];
  for (const result of results) {
    expect(JSON.stringify(result)).not.toContain('sk-secret-123');
  }
});
