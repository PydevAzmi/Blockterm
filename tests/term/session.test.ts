import { Buffer } from 'node:buffer';

import { expect, test } from 'vitest';

import { TerminalSession, type View } from '../../src/term/session.js';
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
