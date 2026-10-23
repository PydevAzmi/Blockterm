import { expect, test } from 'vitest';

import xterm from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';

import { BlockStore, type SnapLine } from '../../src/blocks/store.js';

const { Terminal: XtermTerminal } = xterm;

function makeMirror(cols = 40, rows = 10, scrollback = 1000): Terminal {
  const mirror = new XtermTerminal({ allowProposedApi: true, scrollback, cols, rows });
  mirror.loadAddon(new Unicode11Addon());
  mirror.unicode.activeVersion = '11';
  return mirror;
}

function write(mirror: Terminal, data: string): Promise<void> {
  return new Promise<void>(resolve => mirror.write(data, () => resolve()));
}

function text(line: SnapLine): string {
  return line.cells
    .map(c => c.ch)
    .join('')
    .trimEnd();
}

test('one block: command, exit code, lines and duration', async () => {
  const mirror = makeMirror();
  let t = 1000;
  const store = new BlockStore(mirror, () => t);

  await write(mirror, '\x1b]133;A\x07$ \x1b]133;B\x07ls -la\r\n\x1b]133;C\x07');
  t = 1810;
  await write(mirror, 'a\r\nb\r\n\x1b]133;D;0\x07');

  expect(store.blocks).toHaveLength(1);
  const block = store.blocks[0]!;
  expect(block.id).toBe(1);
  expect(block.command).toBe('ls -la');
  expect(block.exitCode).toBe(0);
  expect(block.cwd).toBeNull();
  expect(block.lines.map(text)).toEqual(['a', 'b']);
  expect(block.endedAt).not.toBeNull();
  expect(block.endedAt! - block.startedAt).toBe(810);
  expect(store.running).toBeNull();
});

test('colour: a coloured line keeps its sgr on every cell', async () => {
  const mirror = makeMirror();
  const store = new BlockStore(mirror);

  await write(mirror, '\x1b]133;B\x07cmd\r\n\x1b]133;C\x07\x1b[31mred\r\n\x1b]133;D;0\x07');

  const line = store.blocks[0]!.lines[0]!;
  expect(text(line)).toBe('red');
  expect(line.cells[0]!.sgr).toBe('31');
  expect(line.cells[1]!.sgr).toBe('31');
});

test('wrapped line: a written space at the wrap point is not trimmed', async () => {
  const mirror = makeMirror(40);
  const store = new BlockStore(mirror);

  await write(
    mirror,
    '\x1b]133;B\x07wrap\r\n\x1b]133;C\x07' + 'a'.repeat(39) + ' b\r\n\x1b]133;D;0\x07',
  );

  const first = store.blocks[0]!.lines[0]!;
  expect(first.wrapped).toBe(true);
  expect(first.cells).toHaveLength(40);
  expect(first.cells[39]!.ch).toBe(' ');
  expect(text(first)).toBe('a'.repeat(39));
});

test('alt screen mid-block: junk from the other screen is not captured', async () => {
  const mirror = makeMirror();
  const store = new BlockStore(mirror);

  await write(mirror, '\x1b]133;C\x07');
  await write(mirror, '\x1b[?1049h junk \x1b[?1049l');
  await write(mirror, 'x\r\n\x1b]133;D;0\x07');

  const lines = store.blocks[0]!.lines.map(text);
  expect(lines).toEqual(['x']);
  expect(lines.join('\n')).not.toContain('junk');
});

test('huge output: keeps head and tail with an omitted count', async () => {
  const mirror = makeMirror(20, 10, 20000);
  const store = new BlockStore(mirror);
  const body = Array.from({ length: 12000 }, (_, i) => `${i + 1}`).join('\r\n');

  await write(
    mirror,
    `\x1b]133;B\x07seq\r\n\x1b]133;C\x07${body}\r\n\x1b]133;D;0\x07`,
  );

  const block = store.blocks[0]!;
  expect(block.lines).toHaveLength(10000);
  expect(block.omitted).toBe(2000);
  expect(text(block.lines[0]!)).toBe('1');
  expect(text(block.lines[9999]!)).toBe('12000');
});

test('idle prompt: blank after B, broken by typing, false while running', async () => {
  const mirror = makeMirror();
  const store = new BlockStore(mirror);

  await write(mirror, '\x1b]133;A\x07$ \x1b]133;B\x07');
  expect(store.isIdlePrompt()).toBe(true);

  await write(mirror, 'x');
  expect(store.isIdlePrompt()).toBe(false);

  const other = makeMirror();
  const running = new BlockStore(other);
  await write(other, '\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07');
  expect(running.isIdlePrompt()).toBe(false);
});

test('clear: drops finished blocks and notifies listeners', async () => {
  const mirror = makeMirror();
  const store = new BlockStore(mirror);
  let changes = 0;
  store.onChange(() => {
    changes += 1;
  });

  await write(mirror, '\x1b]133;B\x07cmd\r\n\x1b]133;C\x07out\r\n\x1b]133;D;0\x07');
  expect(store.blocks).toHaveLength(1);

  const before = changes;
  store.clear();
  expect(store.blocks).toHaveLength(0);
  expect(changes).toBeGreaterThan(before);
});

test('running, promptRow, cwd and integrated track live state', async () => {
  const mirror = makeMirror();
  const store = new BlockStore(mirror);
  expect(store.integrated).toBe(false);
  expect(store.promptRow).toBeNull();
  expect(store.running).toBeNull();

  await write(mirror, '\x1b]7;file://host/home/u\x07');
  expect(store.integrated).toBe(true);
  expect(store.cwd).toBe('/home/u');

  await write(mirror, '\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07');
  expect(store.promptRow).toBeNull();
  expect(store.running).toEqual({ command: 'ls', startedAt: expect.any(Number), startRow: 1 });

  await write(mirror, 'out\r\n\x1b]133;D;0\x07');
  expect(store.running).toBeNull();
  expect(store.blocks[0]!.cwd).toBe('/home/u');
});

test('clear keeps the live prompt and idle state (Ruling AE)', async () => {
  const mirror = makeMirror();
  const store = new BlockStore(mirror);
  await write(mirror, '\x1b]133;A\x07$ \x1b]133;B\x07');
  const row = store.promptRow;
  expect(store.isIdlePrompt()).toBe(true);

  store.clear();
  expect(store.promptRow).toBe(row);
  expect(store.isIdlePrompt()).toBe(true);
});

test('clear mid-run keeps the running block and captures only its output', async () => {
  const mirror = makeMirror();
  const store = new BlockStore(mirror);
  await write(mirror, '\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07');
  store.clear();
  expect(store.running).not.toBeNull();

  await write(mirror, 'out\r\n\x1b]133;D;0\x07');
  const block = store.blocks[0]!;
  expect(block.lines.map(text)).toEqual(['out']);
  expect(block.omitted).toBe(0);
});

test('a prompt while running ends the block with a null exit code', async () => {
  const mirror = makeMirror();
  const store = new BlockStore(mirror);
  await write(mirror, '\x1b]133;B\x07sleep\r\n\x1b]133;C\x07partial\r\n');
  expect(store.running).not.toBeNull();

  await write(mirror, '\x1b]133;A\x07$ ');
  expect(store.running).toBeNull();
  const block = store.blocks[0]!;
  expect(block.command).toBe('sleep');
  expect(block.exitCode).toBeNull();
  expect(block.lines.map(text)).toEqual(['partial']);
});

test('output on the D row is captured as the last line', async () => {
  const mirror = makeMirror();
  const store = new BlockStore(mirror);
  await write(mirror, '\x1b]133;B\x07printf x\r\n\x1b]133;C\x07x\x1b]133;D;0\x07');
  expect(store.blocks[0]!.lines.map(text)).toEqual(['x']);
});

test('finished blocks cap at the newest 200', async () => {
  const mirror = makeMirror(20, 10, 2000);
  const store = new BlockStore(mirror);

  for (let i = 0; i < 201; i += 1) {
    await write(
      mirror,
      `\x1b]133;B\x07cmd${i}\r\n\x1b]133;C\x07out${i}\r\n\x1b]133;D;0\x07`,
    );
  }

  expect(store.blocks).toHaveLength(200);
  expect(store.blocks[0]!.command).toBe('cmd1');
  expect(store.blocks[199]!.command).toBe('cmd200');
});

test('scrollback eviction: omitted counts the lost lines', async () => {
  const mirror = makeMirror(20, 24, 1000);
  const store = new BlockStore(mirror);
  const body = Array.from({ length: 3000 }, (_, i) => `${i + 1}`).join('\r\n');

  await write(
    mirror,
    `\x1b]133;B\x07seq\r\n\x1b]133;C\x07${body}\r\n\x1b]133;D;0\x07`,
  );

  const block = store.blocks[0]!;
  expect(text(block.lines[block.lines.length - 1]!)).toBe('3000');
  expect(Math.abs(block.lines.length + block.omitted - 3000)).toBeLessThanOrEqual(1);
});
