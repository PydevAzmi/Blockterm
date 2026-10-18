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
};

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
  const config: Config = {
    provider: '@ai-sdk/openai-compatible',
    model: 'local-model',
    apiKeyEnv: '',
    baseURL: 'http://localhost:1234/v1',
    name: 'local',
    shell: null,
  };
  const result = createModel(config, {});
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(meta(result.model).provider?.startsWith('local')).toBe(true);
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
