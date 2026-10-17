import { fileURLToPath } from 'node:url';

import type { Terminal as XtermTerminal } from '@xterm/headless';
import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import { expect, test } from 'vitest';

const { Terminal } = xterm;

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
const COLS = 80;
const ROWS = 24;
const FOOTER = 'F1 help · ctrl+k agent · ctrl+l clear';

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

test('blockterm runs a real shell end to end', async () => {
  const host = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const p = spawn(process.execPath, [CLI, '--shell', SHELL], {
    cols: COLS,
    rows: ROWS,
    cwd: ROOT,
    env: process.env,
  });

  let raw = '';
  let exitCode: number | undefined;
  let exited = false;
  p.onData(d => {
    raw += d;
    host.write(d);
  });
  const done = new Promise<void>(resolve =>
    p.onExit(e => {
      exitCode = e.exitCode;
      exited = true;
      resolve();
    }),
  );

  try {
    await waitFor(() => host.buffer.active.type === 'alternate', 15000);
    await waitFor(() => {
      const lines = screen(host).split('\n');
      return lines[0]!.includes('blockterm') && lines[ROWS - 1]!.includes(FOOTER);
    }, 15000);

    await new Promise(resolve => setTimeout(resolve, 3000));
    p.write(SHELL === '/bin/sh' ? 'echo SMOKE$((6*7))\r' : 'Write-Output ("SMOKE" + (6*7))\r');
    await waitFor(() => screen(host).includes('SMOKE42'), 15000);

    p.write('\x1b[200~pasted\x1b[201~');
    await waitFor(() => screen(host).includes('pasted'), 15000);
    p.write('\r');

    await new Promise(resolve => setTimeout(resolve, 500));
    p.write('exit 7\r');
    await done;

    expect(exitCode).toBe(7);
    expect(raw).toContain('\x1b[?1049l');
  } finally {
    if (!exited) p.kill();
  }
}, 20000);
