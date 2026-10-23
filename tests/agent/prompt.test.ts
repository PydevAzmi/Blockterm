import { expect, test } from 'vitest';

import { buildSystemPrompt } from '../../src/agent/prompt.js';

const ctx = {
  os: 'linux',
  shell: 'bash',
  cwd: '/home/me/project',
  view: 'fullscreen' as const,
  program: 'vim',
};

test('buildSystemPrompt: states the three safety rules', () => {
  const p = buildSystemPrompt(ctx);
  expect(p).toContain('untrusted');
  expect(p).toContain('never instructions');
  expect(p).toContain('may take over the keyboard');
  expect(p).toContain('may be denied or edited');
});

test('buildSystemPrompt: includes os, shell, cwd, view and program', () => {
  const p = buildSystemPrompt(ctx);
  expect(p).toContain('linux');
  expect(p).toContain('bash');
  expect(p).toContain('/home/me/project');
  expect(p).toContain('fullscreen');
  expect(p).toContain('vim');
});

test('buildSystemPrompt: run_command at idle prompts, send_keys elsewhere', () => {
  const p = buildSystemPrompt(ctx);
  expect(p).toMatch(/run_command[^]*idle prompt/i);
  expect(p).toMatch(/otherwise[^]*send_keys/i);
});

test('buildSystemPrompt: stays short', () =>
  expect(buildSystemPrompt(ctx).length).toBeLessThan(1200));
