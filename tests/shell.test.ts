import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { isOnPath, resolveShell } from '../src/shell.js';

const env = { SHELL: '/bin/zsh', PATH: '' };

test('windows prefers pwsh', () =>
  expect(resolveShell({ platform: 'win32', env, onPath: e => e === 'pwsh' })).toEqual({ file: 'pwsh.exe', args: ['-NoLogo'] }));
test('windows falls back to powershell.exe', () =>
  expect(resolveShell({ platform: 'win32', env, onPath: () => false })).toEqual({ file: 'powershell.exe', args: ['-NoLogo'] }));
test('unix uses $SHELL', () =>
  expect(resolveShell({ platform: 'linux', env, onPath: () => false })).toEqual({ file: '/bin/zsh', args: [] }));
test('unix falls back to /bin/sh', () =>
  expect(resolveShell({ platform: 'darwin', env: {}, onPath: () => false })).toEqual({ file: '/bin/sh', args: [] }));
test('override wins, no args', () =>
  expect(resolveShell({ platform: 'win32', env, override: 'C:\\x\\bash.exe', onPath: () => true })).toEqual({ file: 'C:\\x\\bash.exe', args: [] }));

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

test.skipIf(process.platform !== 'win32')('isOnPath: win32 reads Path case-insensitively, skips empty segments, applies default PATHEXT', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'fake.EXE'), '');
  expect(isOnPath('fake', { Path: `;${dir}` }, 'win32')).toBe(true);
});

function inDir<T>(dir: string, fn: () => T): T {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
  }
}

test('isOnPath: posix finds executable on PATH', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'fake'), '');
  expect(inDir(dir, () => isOnPath('fake', { PATH: '.' }, 'linux'))).toBe(true);
});

test('isOnPath: posix returns false for a missing executable', () => {
  const dir = tempDir();
  expect(inDir(dir, () => isOnPath('nope', { PATH: '.' }, 'linux'))).toBe(false);
});
