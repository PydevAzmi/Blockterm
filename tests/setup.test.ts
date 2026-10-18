import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { type Config, loadConfig } from '../src/config.js';
import { type Io, runSetup } from '../src/setup.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-setup-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function scripted(answers: string[]): { io: Io; questions: string[]; lines: string[] } {
  const questions: string[] = [];
  const lines: string[] = [];
  let i = 0;
  const io: Io = {
    ask: async (question, def) => {
      questions.push(question);
      const answer = answers[i] ?? '';
      i += 1;
      const trimmed = answer.trim();
      return trimmed === '' && def !== undefined ? def : trimmed;
    },
    print: line => lines.push(line),
  };
  return { io, questions, lines };
}

const anthropic: Config = {
  provider: '@ai-sdk/anthropic',
  model: 'claude-sonnet-4-20250514',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseURL: null,
  name: null,
  shell: null,
};

test('runSetup: picks provider, model and the default key env', async () => {
  const path = join(tempDir(), 'config.json');
  const { io, questions, lines } = scripted(['1', 'claude-haiku-5-5', '']);

  const config = await runSetup(io, path, null);

  expect(config).toEqual({
    provider: '@ai-sdk/anthropic',
    model: 'claude-haiku-5-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseURL: null,
    name: null,
    shell: null,
  });
  expect(loadConfig(path)).toEqual({ ok: true, config });
  expect(lines.some(line => line.includes(path))).toBe(true);
  expect(
    questions.some(question =>
      question.includes(
        '1) @ai-sdk/anthropic  2) @ai-sdk/openai  3) @ai-sdk/openai-compatible',
      ),
    ),
  ).toBe(true);
});

test('runSetup: openai-compatible asks Base URL and Name, and re-asks an empty Name', async () => {
  const path = join(tempDir(), 'config.json');
  const { io, questions } = scripted([
    '3',
    'local-model',
    '',
    'http://localhost:1234/v1',
    '',
    'local',
  ]);

  const config = await runSetup(io, path, null);

  expect(config).toEqual({
    provider: '@ai-sdk/openai-compatible',
    model: 'local-model',
    apiKeyEnv: '',
    baseURL: 'http://localhost:1234/v1',
    name: 'local',
    shell: null,
  });
  expect(questions.filter(question => question.startsWith('Base URL'))).toHaveLength(1);
  expect(questions.filter(question => question.startsWith('Name'))).toHaveLength(2);
});

test('runSetup: re-asks an empty model', async () => {
  const path = join(tempDir(), 'config.json');
  const { io, questions } = scripted(['1', '', 'claude-haiku-5-5', '']);

  const config = await runSetup(io, path, null);

  expect(config.model).toBe('claude-haiku-5-5');
  expect(questions.filter(question => question.startsWith('Model'))).toHaveLength(2);
});

test('runSetup: re-asks an apiKeyEnv that is not an env var name and never saves it', async () => {
  const path = join(tempDir(), 'config.json');
  const { io, lines } = scripted(['1', 'claude-haiku-5-5', 'sk-ant-abc123', '']);

  const config = await runSetup(io, path, null);

  expect(config.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
  expect(readFileSync(path, 'utf8')).not.toContain('sk-ant-abc123');
  expect(lines).toContain('apiKeyEnv must be an environment variable name');
});

test('runSetup: a changed provider resets baseURL, name and key env defaults', async () => {
  const path = join(tempDir(), 'config.json');
  const existing: Config = {
    provider: '@ai-sdk/openai-compatible',
    model: 'local-model',
    apiKeyEnv: '',
    baseURL: 'http://localhost:1234/v1',
    name: 'local',
    shell: 'C:\\bin\\sh.exe',
  };
  const { io } = scripted(['1', 'claude-haiku-5-5', '']);

  const config = await runSetup(io, path, existing);

  expect(config).toEqual({
    provider: '@ai-sdk/anthropic',
    model: 'claude-haiku-5-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseURL: null,
    name: null,
    shell: 'C:\\bin\\sh.exe',
  });
});

test('runSetup: an existing config supplies the defaults on a re-run', async () => {
  const path = join(tempDir(), 'config.json');
  const existing: Config = { ...anthropic, shell: 'C:\\bin\\sh.exe' };
  const { io } = scripted(['', '', '']);

  const config = await runSetup(io, path, existing);

  expect(config).toEqual(existing);
  expect(loadConfig(path)).toEqual({ ok: true, config: existing });
});
