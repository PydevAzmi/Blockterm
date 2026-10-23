import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Terminal as XtermTerminal } from '@xterm/headless';
import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import { beforeAll, expect, test } from 'vitest';

import { healSpawnHelper } from '../../src/term/session.js';

beforeAll(() => {
  healSpawnHelper();
});

const { Terminal } = xterm;

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const SERVER = fileURLToPath(new URL('../fixtures/fake-openai.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
const COLS = 120;
const ROWS = 30;

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

function startServer(recordFile: string): Promise<{ proc: ChildProcess; port: number }> {
  const proc = nodeSpawn(process.execPath, [SERVER, recordFile]);
  return new Promise((resolve, reject) => {
    let buffer = '';
    proc.stdout?.on('data', (data: Buffer) => {
      buffer += String(data);
      const match = /PORT (\d+)/.exec(buffer);
      if (match !== null) resolve({ proc, port: Number(match[1]) });
    });
    proc.on('exit', () => reject(new Error('fake-openai exited before reporting a port')));
  });
}

test('the agent runs a write end to end through openai-compatible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-agent-'));
  const configFile = join(dir, 'config.json');
  const recordFile = join(dir, 'requests.jsonl');
  writeFileSync(recordFile, '');
  const { proc: server, port } = await startServer(recordFile);

  writeFileSync(
    configFile,
    `${JSON.stringify(
      {
        provider: '@ai-sdk/openai-compatible',
        model: 'fake-1',
        apiKeyEnv: '',
        baseURL: `http://127.0.0.1:${port}/v1`,
        name: 'fake',
      },
      null,
      2,
    )}\n`,
  );

  const host = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const p = spawn(process.execPath, [CLI, '--shell', SHELL], {
    cols: COLS,
    rows: ROWS,
    cwd: ROOT,
    env: { ...process.env, BLOCKTERM_CONFIG: configFile },
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
    await waitFor(() => host.buffer.active.type === 'alternate', 15000);
    await waitFor(() => /[#$>]/.test(screen(host)), 15000);

    p.write('\x0b');
    p.write('say ok\r');

    await waitFor(() => screen(host).includes('Type into'), 30000);
    await new Promise(resolve => setTimeout(resolve, 500));
    p.write('y');

    // The shell owns the full width, so PTY text starts at column 0. A row that is
    // exactly AGENT_OK proves the shell ran `echo AGENT_OK`, rather than the agent
    // line merely echoing the command.
    await waitFor(() => /^AGENT_OK\s/m.test(screen(host)), 30000);
    await waitFor(() => screen(host).includes('Done.'), 30000);

    const lines = readFileSync(recordFile, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const second = JSON.parse(lines[1]!);
    const toolMessages = (second.messages as { role: string; content: unknown }[]).filter(
      m => m.role === 'tool',
    );
    expect(toolMessages.length).toBeGreaterThan(0);
    expect(
      toolMessages.some(m => String(m.content).includes('"status":"done"')),
    ).toBe(true);

    p.write('\x0b');
    p.write('exit 0\r');
    await done;
    expect(exitCode).toBe(0);
  } finally {
    if (!exited) p.kill();
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 40000);
