import { expect, test } from 'vitest';

import xterm from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';

import { BlockStore } from '../../src/blocks/store.js';
import { computeLayout } from '../../src/layout.js';
import { composeBlocks } from '../../src/render/blocks.js';
import { composeFrame, FOOTER, type Cell } from '../../src/render/frame.js';

const { Terminal: XtermTerminal } = xterm;

function makeMirror(cols = 40, rows = 12, scrollback = 1000): Terminal {
  const mirror = new XtermTerminal({ allowProposedApi: true, scrollback, cols, rows });
  mirror.loadAddon(new Unicode11Addon());
  mirror.unicode.activeVersion = '11';
  return mirror;
}

function write(mirror: Terminal, data: string): Promise<void> {
  return new Promise<void>(resolve => mirror.write(data, () => resolve()));
}

function rowText(row: Cell[]): string {
  return row.map(cell => cell.ch).join('');
}

function find(row: Cell[], ch: string): Cell {
  const cell = row.find(candidate => candidate.ch === ch);
  expect(cell).toBeDefined();
  return cell!;
}

async function finishedBlock(o: {
  command?: string;
  exitCode?: number;
  body?: string;
  before?: string;
  after?: string;
  cols?: number;
  rows?: number;
} = {}): Promise<{ mirror: Terminal; store: BlockStore }> {
  const mirror = makeMirror(o.cols ?? 40, o.rows ?? 12);
  let now = 1000;
  const store = new BlockStore(mirror, () => now);
  const command = o.command ?? 'ls';
  const body = o.body ?? 'a\r\nb';
  await write(
    mirror,
    `${o.before ?? ''}\x1b]133;A\x07$ \x1b]133;B\x07${command}\r\n\x1b]133;C\x07${body}\r\n`,
  );
  now = 1810;
  await write(mirror, `\x1b]133;D;${o.exitCode ?? 0}\x07${o.after ?? ''}`);
  return { mirror, store };
}

test('finished block: border, status, duration, body and live prompt', async () => {
  const { mirror, store } = await finishedBlock({
    command: 'ls',
    exitCode: 0,
    body: 'a\r\nb',
    after: '\x1b]133;A\x07$ ',
  });

  const result = composeBlocks(mirror, { store, scroll: 0 }, { cols: 40, rows: 12 }, 5000);
  expect(result.docHeight).toBe(5);
  expect(result.rows).toHaveLength(5);

  const top = result.rows[0]!;
  expect(rowText(top).startsWith('┌ $ ls ')).toBe(true);
  expect(rowText(top).endsWith('✔ 0.81s ┐')).toBe(true);
  expect(find(top, '✔').sgr).toBe('32');
  expect(top).toHaveLength(40);

  const first = result.rows[1]!;
  expect(first[0]!.ch).toBe('│');
  expect(first[1]!.ch).toBe('a');
  expect(first[39]!.ch).toBe('│');
  expect(rowText(first).slice(2, 38).trim()).toBe('');

  const second = result.rows[2]!;
  expect(second[0]!.ch).toBe('│');
  expect(second[1]!.ch).toBe('b');
  expect(second[39]!.ch).toBe('│');

  expect(rowText(result.rows[3]!).startsWith('└')).toBe(true);
  expect(rowText(result.rows[3]!).endsWith('┘')).toBe(true);

  const prompt = result.rows[4]!;
  expect(prompt[0]!.ch).toBe('│');
  expect(prompt[1]!.ch).toBe('$');
  expect(prompt[39]!.ch).toBe('│');
  expect(result.cursor).toEqual({ row: 4, col: 3 });
});

test('failed block: exit code in the fail colour', async () => {
  const { mirror, store } = await finishedBlock({ command: 'false', exitCode: 1, body: 'oops' });
  const result = composeBlocks(mirror, { store, scroll: 0 }, { cols: 40, rows: 12 }, 5000);
  const top = result.rows[0]!;
  expect(rowText(top)).toContain('✘ 1');
  expect(find(top, '✘').sgr).toBe('31');
});

test('long command is truncated without overflowing the border', async () => {
  const { mirror, store } = await finishedBlock({
    command: 'x'.repeat(80),
    body: '',
    after: '\x1b]133;A\x07$ ',
  });
  const result = composeBlocks(mirror, { store, scroll: 0 }, { cols: 40, rows: 12 }, 5000);
  const top = result.rows[0]!;
  expect(top).toHaveLength(40);
  expect(rowText(top)).toContain('…');
  expect(top[39]!.ch).toBe('┐');
});

test('reflow: wrapped lines re-wrap by cell width and keep wide chars whole', async () => {
  const line = 'a'.repeat(17) + '世' + 'a'.repeat(41);
  const { mirror, store } = await finishedBlock({ command: 'long', body: line });
  const result = composeBlocks(mirror, { store, scroll: 0 }, { cols: 20, rows: 12 }, 5000);

  expect(result.rows.length).toBeGreaterThan(2);
  for (const row of result.rows) expect(row).toHaveLength(20);
  for (const row of result.rows.slice(1, -1)) {
    expect(row[0]!.ch).toBe('│');
    expect(row[19]!.ch).toBe('│');
    for (let i = 1; i <= 18; i += 1) {
      const cell = row[i]!;
      if (cell.width === 2) {
        expect(i).toBeLessThan(18);
        expect(row[i + 1]!.width).toBe(0);
      }
    }
  }

  const firstBody = result.rows[1]!;
  expect(rowText(firstBody).slice(1, 18)).toBe('a'.repeat(17));
  expect(firstBody[18]!.ch).toBe(' ');

  const secondBody = result.rows[2]!;
  expect(secondBody[1]!.ch).toBe('世');
  expect(secondBody[1]!.width).toBe(2);
  expect(secondBody[2]!.width).toBe(0);
});

test('tall block shows head, marker and tail', async () => {
  const mirror = makeMirror(40, 10, 1000);
  const store = new BlockStore(mirror, () => 1000);
  const body = Array.from({ length: 100 }, (_, i) => `${i + 1}`).join('\r\n');
  await write(mirror, `\x1b]133;B\x07seq\r\n\x1b]133;C\x07${body}\r\n\x1b]133;D;0\x07`);

  const result = composeBlocks(mirror, { store, scroll: 0 }, { cols: 40, rows: 10 }, 5000);
  expect(result.rows).toHaveLength(10);
  expect(rowText(result.rows[0]!).startsWith('┌ $ seq ')).toBe(true);
  expect(rowText(result.rows[1]!)).toContain('1');
  expect(rowText(result.rows[5]!)).toContain('… 93 lines …');
  expect(rowText(result.rows[8]!)).toContain('100');
  expect(rowText(result.rows[9]!).startsWith('└')).toBe(true);
});

test('scroll: five rows up from the bottom and the cursor scrolls away', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`).join('\r\n');
  const { mirror, store } = await finishedBlock({
    command: 'seq',
    body: lines,
    after: '\x1b]133;A\x07$ ',
  });

  const bottom = composeBlocks(mirror, { store, scroll: 0 }, { cols: 40, rows: 10 }, 5000);
  expect(bottom.docHeight).toBe(23);
  expect(bottom.cursor).not.toBeNull();

  const up = composeBlocks(mirror, { store, scroll: 5 }, { cols: 40, rows: 10 }, 5000);
  expect(up.docHeight).toBe(23);
  expect(up.rows).toHaveLength(10);
  expect(rowText(up.rows[0]!)).toContain('L08');
  expect(rowText(up.rows[9]!)).toContain('L17');
  expect(up.cursor).toBeNull();
});

test('frame uses the blocks renderer only when the store is integrated', async () => {
  const { mirror, store } = await finishedBlock({
    command: 'ls',
    body: 'a\r\nb',
    after: '\x1b]133;A\x07$ ',
  });
  const layout = computeLayout({ cols: 40, rows: 12 });
  const frame = composeFrame(
    mirror,
    layout,
    {
      title: 'blockterm',
      footer: FOOTER,
      view: 'blocks',
      blocks: { store, scroll: 0 },
    },
    true,
  );

  expect(frame.cells[1 * 40 + 1]!.ch).toBe('┌');
  expect(frame.cells[1 * 40]!.ch).toBe('│');
  expect(frame.cells[1 * 40 + 39]!.ch).toBe('│');
  expect(frame.cells[2 * 40 + 2]!.ch).toBe('a');
  expect(frame.cursor).toEqual({ row: 5, col: 4, visible: true });
});

test('slice 1 unchanged when the store is not integrated', async () => {
  const layout = computeLayout({ cols: 40, rows: 12 });
  const mirror = makeMirror(layout.pty.cols, layout.pty.rows);
  await write(mirror, 'hi');
  const store = new BlockStore(mirror);
  const chrome = { title: 'blockterm', footer: FOOTER, view: 'blocks' as const };
  const before = composeFrame(mirror, layout, chrome, true);
  const after = composeFrame(mirror, layout, { ...chrome, blocks: { store, scroll: 0 } }, true);
  expect(after).toEqual(before);
});
