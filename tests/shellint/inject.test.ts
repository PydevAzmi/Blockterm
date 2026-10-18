import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { inject, shellKind } from '../../src/shellint/inject.js';
import { BASH_INTEGRATION, PWSH_INTEGRATION, ZSH_INTEGRATION } from '../../src/shellint/scripts.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-inject-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function native(path: string): string {
  if (!/^\/[A-Za-z]\//.test(path)) return path;
  return path.replace(/^\/([A-Za-z])\//, (_m, d: string) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
}

test('shellKind recognises shells by basename without .exe', () => {
  expect(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh');
  expect(shellKind('/bin/zsh')).toBe('zsh');
  expect(shellKind('bash.exe')).toBe('bash');
  expect(shellKind('powershell.exe')).toBe('powershell');
  expect(shellKind('fish')).toBe('other');
});

test('bash injection uses --rcfile pointing at an existing script that is removed by cleanup', () => {
  const root = tempDir();
  const inj = inject({ file: 'bash', args: [] }, {}, root);
  expect(inj.args[0]).toBe('--rcfile');
  const rc = inj.args[1]!;
  expect(existsSync(native(rc))).toBe(true);
  inj.cleanup();
  expect(existsSync(native(rc))).toBe(false);
});

test('zsh injection points ZDOTDIR at a temp dir with .zshrc and records the original', () => {
  const inj = inject({ file: '/bin/zsh', args: [] }, { ZDOTDIR: '/home/me/.config/zsh' }, tempDir());
  const zdotdir = inj.env.ZDOTDIR!;
  expect(zdotdir).toBeDefined();
  expect(existsSync(join(zdotdir, '.zshrc'))).toBe(true);
  expect(inj.env.BLOCKTERM_ORIG_ZDOTDIR).toBe('/home/me/.config/zsh');
  inj.cleanup();
  expect(existsSync(zdotdir)).toBe(false);
});

test('zsh injection records an empty original when the user has no ZDOTDIR', () => {
  const inj = inject({ file: 'zsh', args: [] }, {}, tempDir());
  expect(inj.env.BLOCKTERM_ORIG_ZDOTDIR).toBe('');
  inj.cleanup();
});

test('pwsh injection loads a script with -NoLogo -NoExit -Command', () => {
  const inj = inject({ file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'] }, {}, tempDir());
  expect(inj.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
  const command = inj.args[3]!;
  expect(command.startsWith(". '")).toBe(true);
  expect(command.endsWith("'")).toBe(true);
  expect(existsSync(command.slice(3, -1))).toBe(true);
  inj.cleanup();
  expect(existsSync(command.slice(3, -1))).toBe(false);
});

test('pwsh path is quoted with doubled single quotes', () => {
  const root = mkdtempSync(join(tmpdir(), "blockterm-'quote-"));
  dirs.push(root);
  const inj = inject({ file: 'pwsh', args: [] }, {}, root);
  const command = inj.args[3]!;
  expect(command).toContain("''");
  const unquoted = command.slice(3, -1).replace(/''/g, "'");
  expect(existsSync(unquoted)).toBe(true);
  inj.cleanup();
});

test('BLOCKTERM_NO_INTEGRATION=1 returns the input unchanged', () => {
  const inp = inject({ file: 'bash', args: ['-i'] }, { BLOCKTERM_NO_INTEGRATION: '1' }, tempDir());
  expect(inp.file).toBe('bash');
  expect(inp.args).toEqual(['-i']);
  expect(inp.env).toEqual({});
  inp.cleanup();
});

test('powershell and other shells are left unchanged', () => {
  for (const file of ['powershell.exe', 'fish']) {
    const inj = inject({ file, args: ['-x'] }, {}, tempDir());
    expect(inj.file).toBe(file);
    expect(inj.args).toEqual(['-x']);
    expect(inj.env).toEqual({});
    inj.cleanup();
  }
});

test('the scripts emit OSC 133 and OSC 7 marks', () => {
  for (const script of [BASH_INTEGRATION, ZSH_INTEGRATION, PWSH_INTEGRATION]) {
    for (const token of ['133;A', '133;B', '133;C', '133;D', ']7;file://']) {
      expect(script).toContain(token);
    }
  }
});
