import { expect, test } from 'vitest';

import { parseArgs } from '../src/cli.js';

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
