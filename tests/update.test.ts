import { dirname, join } from 'node:path';

import { expect, test } from 'vitest';

import {
  type InstallKind,
  type Step,
  detectInstall,
  runUpdate,
  spawnStep,
  updateSteps,
} from '../src/update.js';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('detectInstall finds a git clone at the package root', () => {
  const cliFile = join('repo', 'dist', 'cli.js');
  const root = dirname(dirname(cliFile));
  const exists = (p: string) => p === join(root, '.git');
  expect(detectInstall(cliFile, exists)).toEqual({ kind: 'git', root });
});

test('detectInstall falls back to npm without a .git folder', () => {
  const cliFile = join('repo', 'dist', 'cli.js');
  expect(detectInstall(cliFile, () => false)).toEqual({ kind: 'npm' });
});

test('updateSteps for a git clone pulls, installs and builds', () => {
  expect(updateSteps({ kind: 'git', root: '/repo' })).toEqual([
    { cmd: 'git', args: ['pull', '--ff-only'] },
    { cmd: NPM, args: ['install'] },
    { cmd: NPM, args: ['run', 'build'] },
  ] satisfies Step[]);
});

test('updateSteps for an npm install updates the global package', () => {
  expect(updateSteps({ kind: 'npm' })).toEqual([
    { cmd: NPM, args: ['install', '-g', '--allow-scripts=node-pty', 'blockterm@latest'] },
  ] satisfies Step[]);
});

test('runUpdate runs the steps in order in the package root and prints them', async () => {
  const printed: string[] = [];
  const ran: string[] = [];
  const cwds: string[] = [];
  const code = await runUpdate({
    install: { kind: 'git', root: '/repo' },
    run: async (step, cwd) => {
      ran.push(`${step.cmd} ${step.args.join(' ')}`);
      cwds.push(cwd);
      return 0;
    },
    print: line => printed.push(line),
  });

  expect(code).toBe(0);
  expect(ran).toEqual(['git pull --ff-only', `${NPM} install`, `${NPM} run build`]);
  expect(cwds).toEqual(['/repo', '/repo', '/repo']);
  expect(printed).toEqual([
    '$ git pull --ff-only',
    `$ ${NPM} install`,
    `$ ${NPM} run build`,
    'blockterm is up to date. Restart any open blockterm windows.',
  ]);
});

test('runUpdate stops at the first non-zero exit and returns that code', async () => {
  const ran: string[] = [];
  let call = 0;
  const code = await runUpdate({
    install: { kind: 'git', root: '/repo' },
    run: async step => {
      call += 1;
      ran.push(step.args[0]!);
      return call === 2 ? 3 : 0;
    },
    print: () => {},
  });

  expect(code).toBe(3);
  expect(ran).toEqual(['pull', 'install']);
});

test('a failed git pull explains how to recover', async () => {
  const printed: string[] = [];
  const code = await runUpdate({
    install: { kind: 'git', root: '/repo' },
    run: async () => 1,
    print: line => printed.push(line),
  });

  expect(code).toBe(1);
  expect(printed).toContain(
    'Local changes or a diverged branch stopped the update. Commit or stash them, then run blockterm update again.',
  );
});
test('an npm update reads no root and uses the current directory', async () => {
  const cwds: string[] = [];
  await runUpdate({
    install: { kind: 'npm' } satisfies InstallKind,
    run: async (_step, cwd) => {
      cwds.push(cwd);
      return 0;
    },
    print: () => {},
  });
  expect(cwds).toEqual([process.cwd()]);
});

test('a command that cannot start is reported without the diverged hint', async () => {
  const printed: string[] = [];
  const code = await runUpdate({
    install: { kind: 'git', root: '/repo' },
    run: async () => {
      throw new Error('could not run git: spawn git ENOENT');
    },
    print: line => printed.push(line),
  });

  expect(code).toBe(1);
  expect(printed).toContain('could not run git: spawn git ENOENT');
  expect(printed).not.toContain(
    'Local changes or a diverged branch stopped the update. Commit or stash them, then run blockterm update again.',
  );
});

test('spawnStep rejects with the command and message when it cannot start', async () => {
  await expect(
    spawnStep({ cmd: 'blockterm-no-such-cmd-xyz', args: [] }, process.cwd()),
  ).rejects.toThrow(/could not run blockterm-no-such-cmd-xyz:/);
});
