import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

import { createIo, isMain, parseArgs, shellExists } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { runSetup } from '../src/setup.js';

test('no args runs with the default shell', () =>
  expect(parseArgs([])).toEqual({ kind: 'run' }));

test('--version prints the version', () =>
  expect(parseArgs(['--version'])).toEqual({ kind: 'version' }));

test('-v prints the version', () =>
  expect(parseArgs(['-v'])).toEqual({ kind: 'version' }));

test('--help prints help', () =>
  expect(parseArgs(['--help'])).toEqual({ kind: 'help' }));

test('-h prints help', () =>
  expect(parseArgs(['-h'])).toEqual({ kind: 'help' }));

test('--shell takes a path', () =>
  expect(parseArgs(['--shell', 'C:\\bash.exe'])).toEqual({ kind: 'run', shell: 'C:\\bash.exe' }));

test('--shell without a path is an error', () =>
  expect(parseArgs(['--shell'])).toEqual({ kind: 'error', message: '--shell needs a shell name or path' }));

test('-- passes the rest to the shell', () =>
  expect(parseArgs(['--shell', 'bash', '--', '--login', '-i'])).toEqual({
    kind: 'run',
    shell: 'bash',
    shellArgs: ['--login', '-i'],
  }));

test('-- without --shell is an error', () =>
  expect(parseArgs(['--', '-l'])).toEqual({ kind: 'error', message: 'shell arguments after -- need --shell' }));

test('unknown option is an error', () =>
  expect(parseArgs(['--nope'])).toEqual({ kind: 'error', message: 'unknown option: --nope' }));

test('setup is a subcommand', () =>
  expect(parseArgs(['setup'])).toEqual({ kind: 'setup' }));

test('doctor is a subcommand', () =>
  expect(parseArgs(['doctor'])).toEqual({ kind: 'doctor' }));

test('update is a subcommand', () =>
  expect(parseArgs(['update'])).toEqual({ kind: 'update' }));

test('setup with an extra argument is an error', () =>
  expect(parseArgs(['setup', 'x'])).toEqual({ kind: 'error', message: 'unexpected argument: x' }));

test('createIo reads piped lines through a queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-io-'));
  const input = new PassThrough();
  const output = new PassThrough();
  try {
    input.write('1\nclaude-haiku-5-5\n\n');
    const io = createIo(input, output);
    const path = join(dir, 'config.json');
    const config = await runSetup(io, path, null);
    expect(config).toEqual({
      provider: '@ai-sdk/anthropic',
      model: 'claude-haiku-5-5',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      baseURL: null,
      name: null,
      shell: null,
      headers: null,
      sessionHeader: null,
    });
    expect(loadConfig(path)).toEqual({ ok: true, config });
    io.close();
  } finally {
    input.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createIo resolves the default when the stream closes with no line', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const io = createIo(input, output);
  const answer = io.ask('Model', 'default-model');
  input.end();
  expect(await answer).toBe('default-model');
  io.close();
});

test('shellExists checks a path with a separator on disk', () => {
  expect(shellExists('/opt/custom/sh', {}, 'linux', () => true)).toBe(true);
  expect(shellExists('/opt/custom/sh', {}, 'linux', () => false)).toBe(false);
  expect(shellExists('C:\\bin\\sh.exe', {}, 'win32', () => true)).toBe(true);
});

test('shellExists looks a bare name up on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-shell-'));
  const cwd = process.cwd();
  try {
    writeFileSync(join(dir, 'myshell'), '');
    process.chdir(dir);
    expect(shellExists('myshell', { PATH: '.' }, 'linux')).toBe(true);
    expect(shellExists('nope', { PATH: '.' }, 'linux')).toBe(false);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isMain resolves symlinks and treats a missing argv[1] as not main', ctx => {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-cli-'));
  try {
    const real = join(dir, 'real.js');
    const link = join(dir, 'link.js');
    const other = join(dir, 'other.js');
    writeFileSync(real, '');
    writeFileSync(other, '');
    try {
      symlinkSync(real, link);
    } catch {
      ctx.skip();
      return;
    }

    const url = pathToFileURL(real).href;
    expect(isMain(link, url)).toBe(true);
    expect(isMain(other, url)).toBe(false);
    expect(isMain(undefined, url)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
