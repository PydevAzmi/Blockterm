import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { gitBranch, headerText } from '../../src/render/header.js';

const dirs: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-header-'));
  dirs.push(dir);
  return dir;
}

function file(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

test('gitBranch reads the current branch', () => {
  const root = temp();
  file(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  expect(gitBranch(root)).toBe('main');
});

test('gitBranch walks up from a subfolder', () => {
  const root = temp();
  file(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const sub = join(root, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  expect(gitBranch(sub)).toBe('main');
});

test('gitBranch follows a gitdir file', () => {
  const root = temp();
  file(join(root, 'real', '.git', 'HEAD'), 'ref: refs/heads/worktree\n');
  const work = join(root, 'work');
  file(join(work, '.git'), 'gitdir: ../real/.git\n');
  const sub = join(work, 'src');
  mkdirSync(sub, { recursive: true });
  expect(gitBranch(sub)).toBe('worktree');
});

test('gitBranch shortens a detached HEAD', () => {
  const root = temp();
  const hash = '0123456789abcdef0123456789abcdef01234567';
  file(join(root, '.git', 'HEAD'), `${hash}\n`);
  expect(gitBranch(root)).toBe('0123456');
});

test('gitBranch returns null outside a repo', () => {
  expect(gitBranch(temp())).toBeNull();
});

test('headerText shows folder, branch and model', () => {
  expect(
    headerText({
      folder: '/home/u/proj',
      home: '/home/u',
      branch: 'main',
      model: 'claude-haiku-5-5',
    }),
  ).toBe('~/proj (main) · claude-haiku-5-5');
});

test('headerText with no folder and no model is empty', () => {
  expect(headerText({ folder: null, home: '/home/u', branch: null, model: null })).toBe('');
});

test.runIf(process.platform === 'win32')('headerText matches home across Windows separators', () => {
  expect(
    headerText({
      folder: 'C:/Users/Azmi/Proj',
      home: 'c:\\Users\\Azmi',
      branch: null,
      model: null,
    }),
  ).toBe('~/Proj');
});
