import { Buffer } from 'node:buffer';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { TerminalSession, ensureExecutable, shellName, type View } from '../../src/term/session.js';
import { FakePty } from '../helpers/fake-pty.js';

function make(): { session: TerminalSession; pty: FakePty } {
  const pty = new FakePty();
  const session = new TerminalSession(pty, { cols: 80, rows: 24 });
  return { session, pty };
}

function parsed(session: TerminalSession): Promise<void> {
  return new Promise(r => session.onParsed(r));
}

test('parses output into the mirror', async () => {
  const { session, pty } = make();
  const p = parsed(session);
  pty.emit('hello');
  await p;
  expect(session.mirror.buffer.active.getLine(0)!.translateToString(true)).toBe('hello');
});

test('split UTF-8 code point survives', async () => {
  const { session, pty } = make();
  const p1 = parsed(session);
  pty.emit(Buffer.from([0xc3]));
  await p1;
  const p2 = parsed(session);
  pty.emit(Buffer.from([0xa9]));
  await p2;
  expect(session.mirror.buffer.active.getLine(0)!.translateToString(true)).toBe('é');
});

test('emoji is width 2', async () => {
  const { session, pty } = make();
  const p = parsed(session);
  pty.emit('😀x');
  await p;
  const line = session.mirror.buffer.active.getLine(0)!;
  expect(line.getCell(0)!.getWidth()).toBe(2);
  expect(line.getCell(2)!.getChars()).toBe('x');
});

test('checkmark emoji is width 2', async () => {
  const { session, pty } = make();
  const p = parsed(session);
  pty.emit('✅');
  await p;
  expect(session.mirror.buffer.active.getLine(0)!.getCell(0)!.getWidth()).toBe(2);
});

test('answers DSR', async () => {
  const { session, pty } = make();
  const p = parsed(session);
  pty.emit('\x1b[6n');
  await p;
  expect(pty.written.join('')).toContain('\x1b[1;1R');
});

test('answers DA1', async () => {
  const { session, pty } = make();
  const p = parsed(session);
  pty.emit('\x1b[c');
  await p;
  expect(pty.written.join('')).toMatch(/\x1b\[\?[\d;]+c/);
});

test('answers DECRQM', async () => {
  const { session, pty } = make();
  const p = parsed(session);
  pty.emit('\x1b[?2004$p');
  await p;
  expect(pty.written.join('')).toMatch(/\x1b\[\?2004;\d\$y/);
});

test('answers OSC 11 background query', async () => {
  const { session, pty } = make();
  const p = parsed(session);
  pty.emit('\x1b]11;?\x07');
  await p;
  expect(pty.written.join('')).toMatch(/\x1b\]11;rgb:/);
});

test('answers OSC 10 foreground query', async () => {
  const { session, pty } = make();
  const p = parsed(session);
  pty.emit('\x1b]10;?\x07');
  await p;
  expect(pty.written.join('')).toMatch(/\x1b\]10;rgb:/);
});

test('OSC 11 colour set is not answered', async () => {
  const { session, pty } = make();
  const p = parsed(session);
  pty.emit('\x1b]11;#112233\x07');
  await p;
  expect(pty.written.join('')).not.toContain(']11;');
});

test('alt screen flips view', async () => {
  const { session, pty } = make();
  const views: View[] = [];
  session.onViewChange(v => views.push(v));

  const enter = parsed(session);
  pty.emit('\x1b[?1049h');
  await enter;
  expect(session.view).toBe('fullscreen');
  expect(views).toContain('fullscreen');

  const leave = parsed(session);
  pty.emit('\x1b[?1049l');
  await leave;
  expect(session.view).toBe('blocks');
  expect(views).toEqual(['fullscreen', 'blocks']);
});

test('resize hits pty and mirror', () => {
  const { session, pty } = make();
  session.resize({ cols: 50, rows: 20 });
  expect(pty.resizes).toEqual([[50, 20]]);
  expect(session.mirror.cols).toBe(50);
});

test('program reports the pty process name', () => {
  const { session } = make();
  expect(session.program).toBe('fake-shell');
});

// node-pty on Windows reports the spawn `name` (the TERM value), not a program.
test('a fixed program name wins over the pty process name', () => {
  const session = new TerminalSession(new FakePty(), { cols: 80, rows: 24 }, 'pwsh');
  expect(session.program).toBe('pwsh');
});

test('shellName drops the folder and .exe', () => {
  expect(shellName('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh');
  expect(shellName('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE')).toBe('powershell');
  expect(shellName('/bin/zsh')).toBe('zsh');
});

test('kill kills the pty', () => {
  const { session, pty } = make();
  session.kill();
  expect(pty.killed).toBe(true);
});

test('exit code propagates', () => {
  const { session, pty } = make();
  let code: number | undefined;
  session.onExit(c => {
    code = c;
  });
  pty.exit(3);
  expect(code).toBe(3);
});

test('a signal exit becomes 128 + signal', () => {
  const { session, pty } = make();
  let code: number | undefined;
  session.onExit(c => {
    code = c;
  });
  pty.exit(0, 15);
  expect(code).toBe(143);
});

test('a normal exit with signal 0 keeps the exit code', () => {
  const { session, pty } = make();
  let code: number | undefined;
  session.onExit(c => {
    code = c;
  });
  pty.exit(7, 0);
  expect(code).toBe(7);
  pty.exit(0, 0);
  expect(code).toBe(0);
});

test.skipIf(process.platform === 'win32')('ensureExecutable adds the exec bit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockterm-spawn-'));
  try {
    const file = join(dir, 'spawn-helper');
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    ensureExecutable(file);
    expect(statSync(file).mode & 0o111).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('ensureExecutable ignores a missing file', () => {
  expect(() => ensureExecutable(join(tmpdir(), 'blockterm-no-such-spawn-helper'))).not.toThrow();
});
