import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { type Config, configPath, defaultKeyEnv, loadConfig, saveConfig, validateConfig } from '../src/config.js';

test('configPath: win32 uses APPDATA', () =>
  expect(configPath('win32', { APPDATA: 'C:\\A' }, 'C:\\h')).toBe('C:\\A\\blockterm\\config.json'));
test('configPath: linux uses XDG_CONFIG_HOME', () =>
  expect(configPath('linux', { XDG_CONFIG_HOME: '/x' }, '/h')).toBe('/x/blockterm/config.json'));
test('configPath: darwin falls back to home/.config', () =>
  expect(configPath('darwin', {}, '/h')).toBe('/h/.config/blockterm/config.json'));

const anthropic: Config = {
  provider: '@ai-sdk/anthropic',
  model: 'claude-sonnet-4-20250514',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseURL: null,
  name: null,
  shell: null,
};

test('validateConfig: accepts a full anthropic config', () =>
  expect(validateConfig(anthropic)).toEqual({ ok: true, config: anthropic }));

test('validateConfig: ignores an unknown key', () =>
  expect(validateConfig({ ...anthropic, foo: 'bar' })).toEqual({ ok: true, config: anthropic }));

test('validateConfig: rejects an unknown provider', () => {
  const r = validateConfig({ ...anthropic, provider: 'openai' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain('provider must be one of');
});

test('validateConfig: rejects an empty model', () =>
  expect(validateConfig({ ...anthropic, model: '' }).ok).toBe(false));

test('validateConfig: rejects openai-compatible without baseURL or name', () => {
  const r = validateConfig({ provider: '@ai-sdk/openai-compatible', model: 'm', apiKeyEnv: '' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain('baseURL and name are required');
});

test('validateConfig: accepts openai-compatible with empty apiKeyEnv', () =>
  expect(
    validateConfig({
      provider: '@ai-sdk/openai-compatible',
      model: 'm',
      apiKeyEnv: '',
      baseURL: 'http://localhost:1234',
      name: 'local',
    }),
  ).toEqual({
    ok: true,
    config: {
      provider: '@ai-sdk/openai-compatible',
      model: 'm',
      apiKeyEnv: '',
      baseURL: 'http://localhost:1234',
      name: 'local',
      shell: null,
    },
  }));

test('validateConfig: fills missing optional fields with null', () =>
  expect(
    validateConfig({ provider: '@ai-sdk/anthropic', model: 'm', apiKeyEnv: 'ANTHROPIC_API_KEY' }),
  ).toEqual({ ok: true, config: { ...anthropic, model: 'm' } }));

test('validateConfig: rejects a non-object', () =>
  expect(validateConfig('nope').ok).toBe(false));

test('defaultKeyEnv: maps packages', () => {
  expect(defaultKeyEnv('@ai-sdk/anthropic')).toBe('ANTHROPIC_API_KEY');
  expect(defaultKeyEnv('@ai-sdk/openai')).toBe('OPENAI_API_KEY');
  expect(defaultKeyEnv('@ai-sdk/openai-compatible')).toBe('');
});

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

test('loadConfig: missing file gives reason missing', () => {
  const r = loadConfig(join(tempDir(), 'config.json'));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe('missing');
});

test('loadConfig: broken JSON gives reason invalid', () => {
  const dir = tempDir();
  const file = join(dir, 'config.json');
  writeFileSync(file, '{ not json');
  const r = loadConfig(file);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe('invalid');
});

test('saveConfig: creates parent folders, round-trips, leaves no tmp', () => {
  const dir = tempDir();
  const file = join(dir, 'nested', 'deep', 'config.json');
  saveConfig(file, anthropic);
  expect(loadConfig(file)).toEqual({ ok: true, config: anthropic });
  expect(readdirSync(join(dir, 'nested', 'deep')).filter(n => n.endsWith('.tmp'))).toEqual([]);
});
