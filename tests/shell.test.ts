import { expect, test } from 'vitest';

import { resolveShell } from '../src/shell.js';

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
