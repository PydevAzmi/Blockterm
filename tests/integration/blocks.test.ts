import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Terminal as XtermTerminal } from '@xterm/headless';
import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import { beforeAll, expect, test } from 'vitest';

import { isOnPath } from '../../src/shell.js';
import { shellKind } from '../../src/shellint/inject.js';
import { healSpawnHelper } from '../../src/term/session.js';

beforeAll(() => {
  healSpawnHelper();
});

const { Terminal } = xterm;

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COLS = 80;
const ROWS = 24;
const isWin = process.platform === 'win32';

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

const gitBash = isWin
  ? firstExisting(['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'])
  : null;
const bashPath = isWin
  ? gitBash
  : isOnPath('bash', process.env, process.platform)
    ? 'bash'
    : firstExisting(['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']);
const pwshPath = isOnPath(isWin ? 'pwsh.exe' : 'pwsh', process.env, process.platform)
  ? isWin
    ? 'pwsh.exe'
    : 'pwsh'
  : null;

// Ruling AG: pwsh integration is off on macOS, so never pick pwsh there.
const shellFile = isWin ? gitBash ?? pwshPath : bashPath ?? (process.platform === 'darwin' ? null : pwshPath);

const failCommand =
  shellFile !== null && shellKind(shellFile) === 'bash'
    ? 'false'
    : isWin
      ? 'cmd /c exit 1'
      : "sh -c 'exit 1'";

function screen(host: XtermTerminal): string {
  const buffer = host.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < ROWS; i++) {
    lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

test.skipIf(shellFile === null)(`blocks end to end in a real shell (${shellFile})`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'blockterm-blocks-home-'));
  writeFileSync(join(home, '.bashrc'), '');

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;

  const host = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const p = spawn(process.execPath, [CLI, '--shell', shellFile!], {
    cols: COLS,
    rows: ROWS,
    cwd: ROOT,
    env,
  });

  let exitCode: number | undefined;
  let exited = false;
  p.onData(d => host.write(d));
  const done = new Promise<void>(resolve =>
    p.onExit(e => {
      exitCode = e.exitCode;
      exited = true;
      resolve();
    }),
  );

  try {
    await waitFor(() => host.buffer.active.type === 'alternate', 20000);
    await waitFor(() => /[#$>]/.test(screen(host)), 20000);

    p.write('echo hi\r');
    await waitFor(
      () =>
        screen(host)
          .split('\n')
          .some(line => line.startsWith('$ echo hi ─') && line.includes('✔')),
      20000,
    );

    p.write(`${failCommand}\r`);
    await waitFor(
      () =>
        screen(host)
          .split('\n')
          .some(line => line.startsWith(`$ ${failCommand} ─`) && line.includes('✘')),
      20000,
    );

    p.write('exit 0\r');
    await Promise.race([
      done,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('exit 0 timed out after 30000ms')), 30000),
      ),
    ]);

    expect(exitCode).toBe(0);
  } catch (err) {
    console.log(`\n=== blocks e2e FAILURE (${shellFile}) ===\n${screen(host)}\n=== end ===`);
    throw err;
  } finally {
    if (!exited) p.kill();
    rmSync(home, { recursive: true, force: true });
  }
}, 120000);
