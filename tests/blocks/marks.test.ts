import { expect, test } from 'vitest';

import xterm from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';

import { watchMarks, type Mark } from '../../src/blocks/marks.js';

const { Terminal: XtermTerminal } = xterm;

function makeMirror(cols = 40, rows = 10): Terminal {
  const mirror = new XtermTerminal({ allowProposedApi: true, scrollback: 1000, cols, rows });
  mirror.loadAddon(new Unicode11Addon());
  mirror.unicode.activeVersion = '11';
  return mirror;
}

function write(mirror: Terminal, data: string): Promise<void> {
  return new Promise<void>(resolve => mirror.write(data, () => resolve()));
}

function collect(mirror: Terminal): Mark[] {
  const marks: Mark[] = [];
  watchMarks(mirror, m => marks.push(m));
  return marks;
}

test('full cycle: prompt, command, output with commandText, done', async () => {
  const mirror = makeMirror();
  const marks = collect(mirror);
  await write(
    mirror,
    '\x1b]133;A\x07$ \x1b]133;B\x07ls -la\r\n\x1b]133;C\x07out\r\n\x1b]133;D;0\x07',
  );

  expect(marks.map(m => m.kind)).toEqual(['prompt', 'command', 'output', 'done']);
  expect(marks[0]).toEqual({ kind: 'prompt', row: 0 });
  expect(marks[1]).toEqual({ kind: 'command', row: 0, col: 2 });
  expect(marks[2]).toEqual({ kind: 'output', row: 1, commandText: 'ls -la' });
  expect(marks[3]).toEqual({ kind: 'done', row: 2, exitCode: 0 });
});

test('exit code: D;127 is 127 and a bare D is 0', async () => {
  const mirror = makeMirror();
  const marks = collect(mirror);
  await write(
    mirror,
    '\x1b]133;A\x07\x1b]133;B\x07cmd\r\n\x1b]133;C\x07\x1b]133;D;127\x07',
  );
  await write(
    mirror,
    '\x1b]133;A\x07\x1b]133;B\x07cmd2\r\n\x1b]133;C\x07\x1b]133;D\x07',
  );

  const dones = marks.filter(m => m.kind === 'done');
  expect(dones).toHaveLength(2);
  expect(dones[0]).toEqual({ kind: 'done', row: 1, exitCode: 127 });
  expect(dones[1]).toEqual({ kind: 'done', row: 2, exitCode: 0 });
});

test('OSC 7: percent-decoded path, drive letters kept, non-file ignored', async () => {
  const mirror = makeMirror();
  const marks = collect(mirror);

  await write(mirror, '\x1b]7;file://host/home/u/my%20dir\x07');
  expect(marks).toEqual([{ kind: 'cwd', path: '/home/u/my dir' }]);

  await write(mirror, '\x1b]7;file://host/C:/Users/x\x07');
  expect(marks).toEqual([
    { kind: 'cwd', path: '/home/u/my dir' },
    { kind: 'cwd', path: 'C:/Users/x' },
  ]);

  await write(mirror, '\x1b]7;http://host/etc\x07');
  await write(mirror, '\x1b]7;notaurl\x07');
  expect(marks).toHaveLength(2);
});

test('redraw: a repeated A with nothing between is dropped', async () => {
  const mirror = makeMirror();
  const marks = collect(mirror);
  await write(mirror, '\x1b]133;A\x07\x1b]133;A\x07\x1b]133;B\x07');
  expect(marks.map(m => m.kind)).toEqual(['prompt', 'command']);
});

test('redraw: a doubled A+B pair gives one prompt and one command', async () => {
  const mirror = makeMirror();
  const marks = collect(mirror);
  await write(
    mirror,
    '\x1b]133;A\x07\x1b]133;A\x07\x1b]133;B\x07\x1b]133;B\x07',
  );
  expect(marks.map(m => m.kind)).toEqual(['prompt', 'command']);
});

test('stray D before any C is dropped', async () => {
  const mirror = makeMirror();
  const marks = collect(mirror);
  await write(mirror, '\x1b]133;D;5\x07');
  expect(marks).toEqual([]);

  await write(mirror, '\x1b]133;A\x07\x1b]133;B\x07\x1b]133;D;5\x07');
  expect(marks.map(m => m.kind)).toEqual(['prompt', 'command']);
});

test('fall-through: unknown 133 sub-commands reach later handlers', async () => {
  const mirror = makeMirror();

  const seen: string[] = [];
  mirror.parser.registerOscHandler(133, data => {
    seen.push(data);
    return true;
  });
  const marks = collect(mirror);

  await write(mirror, '\x1b]133;Z\x07');
  expect(seen).toEqual(['Z']);
  expect(marks).toEqual([]);

  await write(mirror, '\x1b]133;A\x07');
  expect(seen).toEqual(['Z']);
  expect(marks.map(m => m.kind)).toEqual(['prompt']);
});
