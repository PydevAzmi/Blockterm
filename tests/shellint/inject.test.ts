import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function scriptOf(command: string): string {
  const m = /ReadAllText\('(.*)'\)\)$/.exec(command);
  return m === null ? '' : m[1]!.replace(/''/g, "'");
}

test('shellKind recognises shells by basename without .exe', () => {
  expect(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh');
  expect(shellKind('/bin/zsh')).toBe('zsh');
  expect(shellKind('bash.exe')).toBe('bash');
  expect(shellKind('powershell.exe')).toBe('powershell');
  expect(shellKind('fish')).toBe('other');
});

const BASH_FILE = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';

test('bash injection uses --rcfile pointing at an existing script that is removed by cleanup', () => {
  const root = tempDir();
  const inj = inject({ file: BASH_FILE, args: [] }, {}, root);
  expect(inj.args[0]).toBe('--rcfile');
  const rc = inj.args[1]!;
  expect(existsSync(native(rc))).toBe(true);
  inj.cleanup();
  expect(existsSync(native(rc))).toBe(false);
});

test.skipIf(process.platform !== 'win32')('win32: only Git for Windows / MSYS bash is integrated', () => {
  const wsl = inject({ file: 'C:\\Windows\\System32\\bash.exe', args: [] }, {}, tempDir());
  expect(wsl.args).toEqual([]);
  expect(wsl.env).toEqual({});
  const cygwin = inject({ file: 'C:\\cygwin64\\bin\\bash.exe', args: [] }, {}, tempDir());
  expect(cygwin.args).toEqual([]);
  const msys = inject({ file: 'D:\\msys64\\usr\\bin\\bash.exe', args: [] }, {}, tempDir());
  expect(msys.args[0]).toBe('--rcfile');
  msys.cleanup();
  const git = inject({ file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: [] }, {}, tempDir());
  expect(git.args[0]).toBe('--rcfile');
  git.cleanup();
});

test('zsh injection points ZDOTDIR at a temp dir with the startup files and records the original', () => {
  const inj = inject({ file: '/bin/zsh', args: [] }, { ZDOTDIR: '/home/me/.config/zsh' }, tempDir());
  const zdotdir = inj.env.ZDOTDIR!;
  expect(zdotdir).toBeDefined();
  for (const name of ['.zshenv', '.zprofile', '.zlogin', '.zshrc']) {
    expect(existsSync(join(zdotdir, name))).toBe(true);
  }
  expect(inj.env.BLOCKTERM_ZDOTDIR).toBe(zdotdir);
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
  const inj = inject(
    { file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'] },
    {},
    tempDir(),
    'linux',
  );
  expect(inj.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
  const command = inj.args[3]!;
  expect(command.startsWith("Invoke-Expression ([System.IO.File]::ReadAllText('")).toBe(true);
  expect(command.endsWith("'))")).toBe(true);
  expect(existsSync(scriptOf(command))).toBe(true);
  inj.cleanup();
  expect(existsSync(scriptOf(command))).toBe(false);
});

test('pwsh path is quoted with doubled single quotes', () => {
  const root = mkdtempSync(join(tmpdir(), "blockterm-'quote-"));
  dirs.push(root);
  const inj = inject({ file: 'pwsh', args: [] }, {}, root, 'linux');
  const command = inj.args[3]!;
  expect(command).toContain("''");
  const unquoted = scriptOf(command).replace(/''/g, "'");
  expect(existsSync(unquoted)).toBe(true);
  inj.cleanup();
});

test('Ruling AG: darwin pwsh is left unchanged while linux and win32 pwsh are injected', () => {
  const untouched = inject({ file: 'pwsh', args: ['-NoLogo'] }, {}, tempDir(), 'darwin');
  expect(untouched.file).toBe('pwsh');
  expect(untouched.args).toEqual(['-NoLogo']);
  expect(untouched.env).toEqual({});
  untouched.cleanup();

  for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
    const inj = inject({ file: 'pwsh', args: ['-NoLogo'] }, {}, tempDir(), platform);
    expect(inj.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
    inj.cleanup();
  }
});

test('BLOCKTERM_NO_INTEGRATION=1 returns the input unchanged', () => {
  const inp = inject({ file: BASH_FILE, args: ['-i'] }, { BLOCKTERM_NO_INTEGRATION: '1' }, tempDir());
  expect(inp.file).toBe(BASH_FILE);
  expect(inp.args).toEqual(['-i']);
  expect(inp.env).toEqual({});
  inp.cleanup();
});

test('other shells are left unchanged', () => {
  for (const file of ['fish', 'cmd.exe']) {
    const inj = inject({ file, args: ['-x'] }, {}, tempDir());
    expect(inj.file).toBe(file);
    expect(inj.args).toEqual(['-x']);
    expect(inj.env).toEqual({});
    inj.cleanup();
  }
});

test('powershell is left unchanged off win32', () => {
  for (const platform of ['linux', 'darwin'] as NodeJS.Platform[]) {
    const inj = inject({ file: 'powershell.exe', args: ['-x'] }, {}, tempDir(), platform);
    expect(inj.args).toEqual(['-x']);
    expect(inj.env).toEqual({});
    inj.cleanup();
  }
});

test('win32 powershell.exe is injected without changing the execution policy, with a BOM script', () => {
  const inj = inject(
    { file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: [] },
    {},
    tempDir(),
    'win32',
  );
  expect(inj.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
  expect(inj.args.join(' ')).not.toContain('ExecutionPolicy');
  const command = inj.args[3]!;
  expect(command.startsWith("Invoke-Expression ([System.IO.File]::ReadAllText('")).toBe(true);
  expect(command.endsWith("'))")).toBe(true);
  const script = scriptOf(command);
  expect(existsSync(script)).toBe(true);
  const raw = readFileSync(script);
  expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]);
  inj.cleanup();
  expect(existsSync(script)).toBe(false);
});

test('pwsh scripts are written with a UTF-8 BOM too', () => {
  const inj = inject({ file: 'pwsh', args: [] }, {}, tempDir(), 'linux');
  const raw = readFileSync(scriptOf(inj.args[3]!));
  expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]);
  inj.cleanup();
});

test('the scripts emit OSC 133 and OSC 7 marks', () => {
  for (const script of [BASH_INTEGRATION, ZSH_INTEGRATION, PWSH_INTEGRATION]) {
    for (const token of ['133;A', '133;B', '133;C', '133;D', ']7;file://']) {
      expect(script).toContain(token);
    }
  }
});
