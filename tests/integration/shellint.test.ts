import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, expect, test } from 'vitest';

import { BlockStore } from '../../src/blocks/store.js';
import type { Block } from '../../src/blocks/store.js';
import { isOnPath } from '../../src/shell.js';
import { inject } from '../../src/shellint/inject.js';
import { healSpawnHelper, spawnSession } from '../../src/term/session.js';
import type { TerminalSession } from '../../src/term/session.js';

beforeAll(() => {
  healSpawnHelper();
});

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

const bashPath =
  process.platform === 'win32'
    ? firstExisting(['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'])
    : isOnPath('bash', process.env, process.platform)
      ? 'bash'
      : firstExisting(['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']);

const zshPath = isOnPath('zsh', process.env, process.platform)
  ? 'zsh'
  : firstExisting(['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh']);

const pwshPath = isOnPath('pwsh', process.env, process.platform) ? 'pwsh' : null;

function screenText(session: TerminalSession): string {
  const buffer = session.mirror.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n');
}

function blockText(block: Block): string {
  return block.lines
    .map(line => line.cells.map(cell => cell.ch).join('').replace(/\s+$/, ''))
    .join('\n');
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function driveRc(shellFile: string, rcName: string, shellArgs: string[]): Promise<void> {
  const home = tempDir('blockterm-int-home-');
  const work = tempDir('blockterm-int-work-');
  writeFileSync(join(home, rcName), 'echo hello-rc\nfalse\n');

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'blockterm',
  };
  const injection = inject({ file: shellFile, args: shellArgs }, env, work);
  const session = spawnSession({ file: injection.file, args: injection.args }, { cols: 100, rows: 30 }, {
    ...env,
    ...injection.env,
  });
  const store = new BlockStore(session.mirror);
  try {
    await waitFor(() => store.integrated && store.promptRow !== null, 20000);

    session.write('echo hi\r');
    await waitFor(() => store.blocks.length >= 1 && store.promptRow !== null, 20000);

    session.write('false\r');
    await waitFor(() => store.blocks.length >= 2, 20000);

    const [first, second] = store.blocks;
    expect(first!.command).toContain('echo hi');
    expect(first!.exitCode).toBe(0);
    expect(blockText(first!)).toContain('hi');
    expect(second!.command).toContain('false');
    expect(second!.exitCode).toBe(1);
    expect(screenText(session)).toContain('hello-rc');
  } finally {
    store.dispose();
    session.dispose();
    injection.cleanup();
  }
}

test.skipIf(bashPath === null)('bash: integration survives a noisy failing rc and records blocks', async () => {
  await driveRc(bashPath!, '.bashrc', []);
}, 40000);

test.skipIf(zshPath === null)('zsh: integration survives a noisy failing rc and records blocks', async () => {
  await driveRc(zshPath!, '.zshrc', []);
}, 40000);

test.skipIf(pwshPath === null)('pwsh: integration records a block and propagates the exit code', async () => {
  const home = tempDir('blockterm-int-home-');
  const work = tempDir('blockterm-int-work-');
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TERM_PROGRAM: 'blockterm',
  };
  const injection = inject({ file: pwshPath!, args: [] }, env, work);
  const session = spawnSession({ file: injection.file, args: injection.args }, { cols: 100, rows: 30 }, {
    ...env,
    ...injection.env,
  });
  const store = new BlockStore(session.mirror);
  let exited: number | undefined;
  session.onExit(code => {
    exited = code;
  });
  try {
    await waitFor(() => store.integrated && store.promptRow !== null, 40000);

    session.write('Write-Output hi\r');
    await waitFor(() => store.blocks.length >= 1 && store.promptRow !== null, 40000);

    const block = store.blocks[0]!;
    expect(block.command).toContain('Write-Output hi');
    expect(block.exitCode).toBe(0);
    expect(blockText(block)).toContain('hi');

    session.write('exit 3\r');
    await waitFor(() => exited !== undefined, 40000);
    expect(exited).toBe(3);
  } finally {
    store.dispose();
    session.dispose();
    injection.cleanup();
  }
}, 60000);
