import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { copyText, nativeTool, osc52 } from '../src/clipboard.js';

class FakeStdin extends EventEmitter {
  readonly chunks: Buffer[] = [];
  ended = false;

  end(chunk?: Buffer): void {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
}

function fakeSpawn(): {
  spawn: typeof import('node:child_process').spawn;
  calls: { cmd: string; args: readonly string[]; opts: unknown }[];
  child: FakeChild;
} {
  const calls: { cmd: string; args: readonly string[]; opts: unknown }[] = [];
  const child = new FakeChild();
  const spawn = ((cmd: string, args: readonly string[], opts: unknown) => {
    calls.push({ cmd, args, opts });
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawn, calls, child };
}

test('osc52 encodes UTF-8 as base64 between the OSC 52 markers', () => {
  expect(osc52('世 é\n')).toBe(
    `\x1b]52;c;${Buffer.from('世 é\n', 'utf8').toString('base64')}\x07`,
  );
});

test('nativeTool picks PowerShell Set-Clipboard with base64 input on Windows', () => {
  const tool = nativeTool('win32', {}, cmd => cmd === 'powershell');
  expect(tool?.cmd).toBe('powershell');
  expect(tool?.encoding).toBe('base64');
  expect(tool?.args.at(-1)).toContain('Set-Clipboard');
});

test('nativeTool picks pbcopy on macOS', () => {
  const present = (cmd: string): boolean => cmd === 'pbcopy';
  expect(nativeTool('darwin', {}, present)).toEqual({
    cmd: 'pbcopy',
    args: [],
    encoding: 'utf8',
  });
});

test('nativeTool prefers wl-copy on Wayland and falls back to xclip', () => {
  expect(
    nativeTool('linux', { WAYLAND_DISPLAY: 'wayland-0' }, cmd => cmd === 'wl-copy'),
  ).toEqual({ cmd: 'wl-copy', args: [], encoding: 'utf8' });

  expect(
    nativeTool('linux', { WAYLAND_DISPLAY: 'wayland-0' }, cmd => cmd === 'xclip'),
  ).toEqual({ cmd: 'xclip', args: ['-selection', 'clipboard'], encoding: 'utf8' });

  expect(nativeTool('linux', {}, cmd => cmd === 'xclip')).toEqual({
    cmd: 'xclip',
    args: ['-selection', 'clipboard'],
    encoding: 'utf8',
  });
});

test('nativeTool returns null when no tool exists', () => {
  expect(nativeTool('linux', {}, () => false)).toBeNull();
  expect(nativeTool('win32', {}, () => false)).toBeNull();
  expect(nativeTool('darwin', {}, () => false)).toBeNull();
});

test('copyText always writes OSC 52 and pipes exactly the text, as base64, on Windows', () => {
  for (const text of ['1296', '世 é\n']) {
    const host: string[] = [];
    const fake = fakeSpawn();

    copyText(text, {
      writeHost: s => host.push(s),
      platform: 'win32',
      env: {},
      spawn: fake.spawn,
      has: cmd => cmd === 'powershell',
    });

    expect(host).toEqual([osc52(text)]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.cmd).toBe('powershell');
    expect(fake.calls[0]!.opts).toMatchObject({
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    expect(fake.child.stdin.chunks).toHaveLength(1);
    // No BOM, nothing extra: the payload decodes back to the text and only the text.
    const sent = fake.child.stdin.chunks[0]!.toString('ascii');
    expect(Buffer.from(sent, 'base64').toString('utf8')).toBe(text);
    expect(fake.child.stdin.ended).toBe(true);
  }
});

test('copyText pipes UTF-8 without a BOM to pbcopy', () => {
  const fake = fakeSpawn();

  copyText('世 é\n', {
    writeHost: () => {},
    platform: 'darwin',
    env: {},
    spawn: fake.spawn,
    has: cmd => cmd === 'pbcopy',
  });

  expect(fake.child.stdin.chunks[0]).toEqual(Buffer.from('世 é\n', 'utf8'));
});

test('copyText swallows spawn and stdin errors', () => {
  const fake = fakeSpawn();

  expect(() => {
    copyText('x', {
      writeHost: () => {},
      platform: 'darwin',
      env: {},
      spawn: fake.spawn,
      has: cmd => cmd === 'pbcopy',
    });
    fake.child.emit('error', new Error('ENOENT'));
    fake.child.stdin.emit('error', new Error('EPIPE'));
  }).not.toThrow();
});

test('copyText finds the native tool on PATH when has is not supplied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-clipboard-'));
  try {
    writeFileSync(join(dir, 'xclip'), '');
    const fake = fakeSpawn();

    copyText('x', {
      writeHost: () => {},
      platform: 'linux',
      env: { PATH: dir },
      spawn: fake.spawn,
    });

    expect(fake.calls[0]!.cmd).toBe('xclip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copyText finds Windows commands through PATHEXT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-clipboard-'));
  try {
    writeFileSync(join(dir, 'powershell.EXE'), '');
    const fake = fakeSpawn();

    copyText('x', {
      writeHost: () => {},
      platform: 'win32',
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      spawn: fake.spawn,
    });

    expect(fake.calls[0]!.cmd).toBe('powershell');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
