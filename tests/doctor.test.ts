import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LanguageModel } from 'ai';

import { afterEach, expect, test } from 'vitest';

import { type Config, saveConfig } from '../src/config.js';
import { type Check, runDoctor } from '../src/doctor.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-doctor-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const anthropic: Config = {
  provider: '@ai-sdk/anthropic',
  model: 'claude-haiku-5-5',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseURL: null,
  name: null,
  shell: null,
};

function mockModel(callTool: boolean): LanguageModel {  let step = 0;
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async () => {
      step += 1;
      if (callTool && step === 1) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{}' }],
          finishReason: 'tool-calls',
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text', text: 'done' }],
        finishReason: 'stop',
        usage,
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error('doStream is not used');
    },
  } as unknown as LanguageModel;
}

function throwingModel(message: string): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error(message);
    },
    doStream: async () => {
      throw new Error(message);
    },
  } as unknown as LanguageModel;
}

function checkNamed(checks: Check[], name: string): Check {
  const found = checks.find(check => check.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
}

const base = {
  platform: process.platform,
  shellFile: process.execPath,
};

test('runDoctor: checks report in order and node passes on a modern runtime', async () => {
  const configPath = join(tempDir(), 'config.json');
  saveConfig(configPath, anthropic);

  const checks = await runDoctor({
    ...base,
    configPath,
    env: { ANTHROPIC_API_KEY: 'key' },
    modelOverride: mockModel(true),
  });

  expect(checks.map(check => check.name)).toEqual(['node', 'pty', 'shell', 'config', 'key', 'model']);
  expect(checkNamed(checks, 'node').ok).toBe(true);
  expect(checkNamed(checks, 'model')).toEqual({ name: 'model', ok: true, detail: 'tool calls work' });
});

test('runDoctor: a missing config fails and skips key and model', async () => {
  const checks = await runDoctor({
    ...base,
    configPath: join(tempDir(), 'missing.json'),
    env: {},
    modelOverride: mockModel(true),
  });

  expect(checkNamed(checks, 'config')).toEqual({
    name: 'config',
    ok: false,
    detail: 'run blockterm setup',
  });
  expect(checkNamed(checks, 'key')).toEqual({ name: 'key', ok: false, detail: 'skipped' });
  expect(checkNamed(checks, 'model')).toEqual({ name: 'model', ok: false, detail: 'skipped' });
});

test('runDoctor: a missing key says which env var to set and skips model', async () => {
  const configPath = join(tempDir(), 'config.json');
  saveConfig(configPath, anthropic);

  const checks = await runDoctor({
    ...base,
    configPath,
    env: {},
    modelOverride: mockModel(true),
  });

  expect(checkNamed(checks, 'key')).toEqual({
    name: 'key',
    ok: false,
    detail: 'set ANTHROPIC_API_KEY',
  });
  expect(checkNamed(checks, 'model')).toEqual({ name: 'model', ok: false, detail: 'skipped' });
});

test('runDoctor: a model that never calls the tool fails the model check', async () => {
  const configPath = join(tempDir(), 'config.json');
  saveConfig(configPath, anthropic);

  const checks = await runDoctor({
    ...base,
    configPath,
    env: { ANTHROPIC_API_KEY: 'key' },
    modelOverride: mockModel(false),
  });

  expect(checkNamed(checks, 'model')).toEqual({
    name: 'model',
    ok: false,
    detail: 'model answered but did not call the tool — the agent needs a tool-capable model',
  });
});

test('runDoctor: redacts the key value out of a provider error message', async () => {
  const configPath = join(tempDir(), 'config.json');
  saveConfig(configPath, anthropic);

  const checks = await runDoctor({
    ...base,
    configPath,
    env: { ANTHROPIC_API_KEY: 'sk-secret-123' },
    modelOverride: throwingModel('401 invalid x-api-key sk-secret-123'),
  });

  const model = checkNamed(checks, 'model');
  expect(model.ok).toBe(false);
  expect(model.detail).toContain('401');
  expect(model.detail).not.toContain('sk-secret-123');
});
