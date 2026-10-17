import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

import { isMain, parseArgs } from '../src/cli.js';

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
  expect(parseArgs(['--shell'])).toEqual({ kind: 'error', message: '--shell needs a path' }));

test('unknown option is an error', () =>
  expect(parseArgs(['--nope'])).toEqual({ kind: 'error', message: 'unknown option: --nope' }));

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
