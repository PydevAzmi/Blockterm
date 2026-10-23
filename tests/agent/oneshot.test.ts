import { expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';

import type { Block, SnapLine } from '../../src/blocks/store.js';
import {
  cleanSuggestion,
  explainError,
  explainRequest,
  suggestCommand,
  type OneShotContext,
} from '../../src/agent/oneshot.js';

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function reply(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

function line(text: string): SnapLine {
  return {
    wrapped: false,
    cells: [...text].map(ch => ({ ch, width: 1 as const, sgr: '' })),
  };
}

function block(lines: SnapLine[], overrides: Partial<Block> = {}): Block {
  return {
    id: 1,
    command: 'npm test',
    cwd: '/tmp/project',
    exitCode: 1,
    startedAt: 0,
    endedAt: 1,
    lines,
    omitted: 0,
    ...overrides,
  };
}

const ctx: OneShotContext = { os: 'linux', shell: '/bin/bash', folder: '/tmp/project' };

test('cleanSuggestion keeps only the first usable command line', () => {
  expect(cleanSuggestion('```bash\nls -la\n```')).toBe('ls -la');
  expect(cleanSuggestion('ls -la\nrm -rf /')).toBe('ls -la');
  expect(cleanSuggestion('$ du -sh *')).toBe('du -sh *');
  expect(cleanSuggestion('  \n\nfind . -size +100M\r\n')).toBe('find . -size +100M');
  expect(cleanSuggestion('echo \x1b[31mhi\x07')).toBe('echo [31mhi');
  expect(cleanSuggestion('`ls`')).toBe('ls');
  expect(cleanSuggestion('')).toBe('');
});

test('suggestCommand sends a request with no tools and takes the first suggestion', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => reply('```sh\ngit status\n```'),
  });

  const suggestion = await suggestCommand({
    model,
    ctx,
    request: 'show me what changed',
    signal: new AbortController().signal,
  });

  expect(suggestion).toBe('git status');
  const options = model.doGenerateCalls[0]!;
  expect(options.tools ?? []).toEqual([]);

  const system = options.prompt.find(message => message.role === 'system');
  expect(system?.content).toBe(
    'You turn a request into one shell command. Reply with the command only: no explanation, no code fences.\n' +
      'OS: linux\nShell: /bin/bash\nFolder: /tmp/project',
  );

  const user = options.prompt.find(message => message.role === 'user') as
    | { content: { text?: string }[] }
    | undefined;
  expect(user?.content.map(part => part.text ?? '').join('')).toBe('show me what changed');
});

test('explainRequest includes the command, exit code and only the last 200 lines', () => {
  const lines = Array.from({ length: 300 }, (_, index) => line(`L${index + 1}`));
  const request = explainRequest(block(lines));

  expect(request).toContain('Command: npm test');
  expect(request).toContain('Exit code: 1');
  expect(request).toContain('L101');
  expect(request).toContain('L300');
  expect(request).not.toContain('L100');
});

test('explainError returns the trimmed model text', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => reply('  Cause: missing dependency.\nFix: npm install  \n'),
  });

  const explanation = await explainError({
    model,
    ctx,
    block: block([line('boom')]),
    signal: new AbortController().signal,
  });

  expect(explanation).toBe('Cause: missing dependency.\nFix: npm install');
  expect(model.doGenerateCalls[0]!.tools ?? []).toEqual([]);
});

test('explainError rejects when the signal aborts during the call', async () => {
  const controller = new AbortController();
  const model = new MockLanguageModelV4({
    doGenerate: options =>
      new Promise((_, reject) => {
        options.abortSignal?.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
  });

  const pending = explainError({
    model,
    ctx,
    block: block([line('boom')]),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);

  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

test('one-shot calls reject on abort even when the provider ignores the signal', async () => {
  const late = (text: string) => () =>
    new Promise<ReturnType<typeof reply>>(resolve => setTimeout(() => resolve(reply(text)), 50));

  const explainCtl = new AbortController();
  const explaining = explainError({
    model: new MockLanguageModelV4({ doGenerate: late('late explanation') }),
    ctx,
    block: block([line('boom')]),
    signal: explainCtl.signal,
  });
  const suggestCtl = new AbortController();
  const suggesting = suggestCommand({
    model: new MockLanguageModelV4({ doGenerate: late('rm -rf /tmp/x') }),
    ctx,
    request: 'clean up',
    signal: suggestCtl.signal,
  });
  setTimeout(() => {
    explainCtl.abort();
    suggestCtl.abort();
  }, 10);

  await expect(explaining).rejects.toBeDefined();
  await expect(suggesting).rejects.toBeDefined();
});
