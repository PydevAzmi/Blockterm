import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { spawnSession, type TerminalSession, type View } from '../../src/term/session.js';

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

function mirrorText(session: TerminalSession): string {
  const buffer = session.mirror.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
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

function spawn(name: string): TerminalSession {
  return spawnSession(
    { file: process.execPath, args: [fixture(name)] },
    { cols: 80, rows: 24 },
    process.env,
  );
}

test('prints output into the mirror and exits 0', async () => {
  const session = spawn('hello.mjs');
  let code: number | undefined;
  session.onExit(c => {
    code = c;
  });
  try {
    await waitFor(() => mirrorText(session).includes('hello'), 10000);
    await waitFor(() => code !== undefined, 10000);
    expect(code).toBe(0);
  } finally {
    session.dispose();
  }
}, 10000);

test('propagates a non-zero exit code', async () => {
  const session = spawn('exit3.mjs');
  let code: number | undefined;
  session.onExit(c => {
    code = c;
  });
  try {
    await waitFor(() => code !== undefined, 10000);
    expect(code).toBe(3);
  } finally {
    session.dispose();
  }
}, 10000);

test('alt screen flips the view to fullscreen then back to blocks', async () => {
  const session = spawn('altscreen.mjs');
  const views: View[] = [];
  let code: number | undefined;
  session.onViewChange(v => views.push(v));
  session.onExit(c => {
    code = c;
  });
  try {
    await waitFor(() => views.includes('fullscreen') && views.includes('blocks'), 10000);
    expect(views).toContain('fullscreen');
    expect(views).toContain('blocks');
    expect(views.indexOf('fullscreen')).toBeLessThan(views.indexOf('blocks'));
    await waitFor(() => code !== undefined, 10000);
    expect(code).toBe(0);
  } finally {
    session.dispose();
  }
}, 10000);

test('resize reaches the real child', async () => {
  const session = spawn('resize.mjs');
  let code: number | undefined;
  session.onExit(c => {
    code = c;
  });
  try {
    await waitFor(() => mirrorText(session).includes('cols:'), 10000);
    session.resize({ cols: 60, rows: 20 });
    await waitFor(() => mirrorText(session).includes('cols:60'), 2000);
    session.write('x');
    await waitFor(() => code !== undefined, 5000);
  } finally {
    session.dispose();
  }
}, 10000);

test('DSR query round trip reaches the child', async () => {
  const session = spawn('dsr.mjs');
  let code: number | undefined;
  session.onExit(c => {
    code = c;
  });
  try {
    await waitFor(() => mirrorText(session).includes('R'), 10000);
    await waitFor(() => code !== undefined, 10000);
  } finally {
    session.dispose();
  }
}, 10000);

test('missing shell throws or exits non-zero within 2s', async () => {
  let session: TerminalSession | undefined;
  let threw = false;
  let code: number | undefined;
  try {
    session = spawnSession(
      { file: 'definitely-not-a-shell-xyz', args: [] },
      { cols: 80, rows: 24 },
      process.env,
    );
    session.onExit(c => {
      code = c;
    });
  } catch {
    threw = true;
  }
  try {
    if (!threw) {
      await waitFor(() => code !== undefined, 2000);
      expect(code).not.toBe(0);
    }
    expect(threw || code !== undefined).toBe(true);
  } finally {
    session?.dispose();
  }
}, 10000);
