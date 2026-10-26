import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  type Config,
  colorSgr,
  configPath,
  defaultKeyEnv,
  loadConfig,
  saveConfig,
  validateConfig,
} from '../src/config.js';

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
  headers: null,
  sessionHeader: null,
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
      headers: null,
      sessionHeader: null,
    },
  }));

test('validateConfig: accepts headers and a sessionHeader', () =>
  expect(
    validateConfig({
      ...anthropic,
      headers: { 'X-App': 'blockterm', 'x-trace-id': 'abc' },
      sessionHeader: 'x-opencode-session',
    }),
  ).toEqual({
    ok: true,
    config: {
      ...anthropic,
      headers: { 'X-App': 'blockterm', 'x-trace-id': 'abc' },
      sessionHeader: 'x-opencode-session',
    },
  }));

test('validateConfig: rejects headers that are not an object', () =>
  expect(validateConfig({ ...anthropic, headers: 'nope' }).ok).toBe(false));

test('validateConfig: rejects a header value that is not a string', () =>
  expect(validateConfig({ ...anthropic, headers: { 'X-A': 42 } }).ok).toBe(false));

test('validateConfig: rejects an invalid header name and never echoes the value', () => {
  const r = validateConfig({ ...anthropic, headers: { 'Bad Header': 'sk-secretvalue123' } });
  expect(r.ok).toBe(false);
  expect(JSON.stringify(r)).not.toContain('sk-secretvalue123');
});

test('validateConfig: rejects an invalid sessionHeader and never echoes it', () => {
  const r = validateConfig({ ...anthropic, sessionHeader: 'not a header' });
  expect(r.ok).toBe(false);
  expect(JSON.stringify(r)).not.toContain('not a header');
});

test('validateConfig: strips a trailing /chat/completions from baseURL', () =>
  expect(validateConfig({ ...anthropic, baseURL: 'https://x/v1/chat/completions' })).toEqual({
    ok: true,
    config: { ...anthropic, baseURL: 'https://x/v1' },
  }));

test('validateConfig: strips /chat/completions even with a trailing slash', () =>
  expect(validateConfig({ ...anthropic, baseURL: 'https://x/v1/chat/completions/' })).toEqual({
    ok: true,
    config: { ...anthropic, baseURL: 'https://x/v1' },
  }));

test('validateConfig: fills missing optional fields with null', () =>
  expect(
    validateConfig({ provider: '@ai-sdk/anthropic', model: 'm', apiKeyEnv: 'ANTHROPIC_API_KEY' }),
  ).toEqual({ ok: true, config: { ...anthropic, model: 'm' } }));

test('validateConfig: rejects an apiKeyEnv that is not an environment variable name', () => {
  const r = validateConfig({ ...anthropic, apiKeyEnv: 'sk-ant-abc123' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toBe('apiKeyEnv must be an environment variable name');
  expect(JSON.stringify(r)).not.toContain('sk-ant-abc123');
});

test('validateConfig: accepts an empty apiKeyEnv', () =>
  expect(validateConfig({ ...anthropic, apiKeyEnv: '' })).toEqual({
    ok: true,
    config: { ...anthropic, apiKeyEnv: '' },
  }));

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

test('validateConfig: accepts agentColor names, 0-255 and #rrggbb', () => {
  for (const agentColor of ['magenta', 'bright-cyan', 'gray', '141', '#7aa2f7']) {
    const result = validateConfig({ ...anthropic, agentColor });
    expect(result.ok && result.config.agentColor).toBe(agentColor);
  }
});

test('validateConfig: rejects an unknown agentColor', () =>
  expect(validateConfig({ ...anthropic, agentColor: 'sparkly' })).toEqual({
    ok: false,
    reason: 'invalid',
    message: 'agentColor must be a color name, 0-255, or #rrggbb',
  }));

test('validateConfig: accepts rtl auto, on and off', () => {
  for (const rtl of ['auto', 'on', 'off'] as const) {
    const result = validateConfig({ ...anthropic, rtl });
    expect(result.ok && result.config.rtl).toBe(rtl);
  }
});

test('validateConfig: rejects an unknown rtl', () =>
  expect(validateConfig({ ...anthropic, rtl: 'sideways' })).toEqual({
    ok: false,
    reason: 'invalid',
    message: 'rtl must be "auto", "on" or "off"',
  }));

test('saveConfig: round-trips rtl', () => {
  const file = join(tempDir(), 'config.json');
  const config: Config = { ...anthropic, rtl: 'on' };
  saveConfig(file, config);
  expect(loadConfig(file)).toEqual({ ok: true, config });
});

test('colorSgr maps specs to SGR and defaults to cyan', () => {
  expect(colorSgr(null)).toBe('36');
  expect(colorSgr('magenta')).toBe('35');
  expect(colorSgr('bright-red')).toBe('91');
  expect(colorSgr('141')).toBe('38;5;141');
  expect(colorSgr('#7AA2F7')).toBe('38;2;122;162;247');
  expect(colorSgr('nope')).toBe('36');
});

test('validateConfig: shellArgs must be an array of strings', () => {
  const ok = validateConfig({ ...anthropic, shell: 'bash', shellArgs: ['--login'] });
  expect(ok.ok && ok.config.shellArgs).toEqual(['--login']);
  expect(validateConfig({ ...anthropic, shellArgs: '--login' })).toEqual({
    ok: false,
    reason: 'invalid',
    message: 'shellArgs must be an array of strings',
  });
});
