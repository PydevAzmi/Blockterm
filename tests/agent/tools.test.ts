import { expect, test } from 'vitest';

import xterm from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';

import { readTools, type ToolContext } from '../../src/agent/tools.js';
import { BlockStore } from '../../src/blocks/store.js';
import { TerminalSession } from '../../src/term/session.js';
import { FakePty } from '../helpers/fake-pty.js';

const { Terminal: XtermTerminal } = xterm;

function makeMirror(cols = 40, rows = 10, scrollback = 2000): Terminal {
  const mirror = new XtermTerminal({ allowProposedApi: true, scrollback, cols, rows });
  mirror.loadAddon(new Unicode11Addon());
  mirror.unicode.activeVersion = '11';
  return mirror;
}

function write(mirror: Terminal, data: string): Promise<void> {
  return new Promise<void>(resolve => mirror.write(data, () => resolve()));
}

function context(blocks: BlockStore | null): ToolContext {
  const session = new TerminalSession(new FakePty(), { cols: 40, rows: 10 });
  return { session, appCursor: () => false, blocks };
}

async function execute(tool: unknown, input: unknown): Promise<unknown> {
  const executable = tool as {
    execute: (input: unknown, options: Record<string, unknown>) => unknown;
  };
  return await executable.execute(input, {
    toolCallId: 'test',
    messages: [],
    context: undefined,
  });
}

async function oneBlock(
  body: string,
  command = 'ls -la',
  cols = 40,
): Promise<{ mirror: Terminal; store: BlockStore }> {
  const mirror = makeMirror(cols);
  const store = new BlockStore(mirror);
  await write(
    mirror,
    `\x1b]7;file://host/tmp\x07\x1b]133;A\x07$ \x1b]133;B\x07${command}\r\n\x1b]133;C\x07${body}\r\n\x1b]133;D;0\x07`,
  );
  return { mirror, store };
}

test('list_blocks returns block metadata, newest last', async () => {
  const mirror = makeMirror();
  const store = new BlockStore(mirror);
  await write(
    mirror,
    '\x1b]7;file://host/tmp\x07' +
      '\x1b]133;A\x07$ \x1b]133;B\x07ls -la\r\n\x1b]133;C\x07a\r\nb\r\n\x1b]133;D;0\x07' +
      '\x1b]133;A\x07$ \x1b]133;B\x07pwd\r\n\x1b]133;C\x07/tmp\r\n\x1b]133;D;0\x07',
  );

  const list = await execute(readTools(context(store)).list_blocks, {});

  expect(list).toEqual([
    { id: 1, command: 'ls -la', exitCode: 0, cwd: '/tmp', lines: 2 },
    { id: 2, command: 'pwd', exitCode: 0, cwd: '/tmp', lines: 1 },
  ]);
});

test('list_blocks caps at the newest 50', async () => {
  const mirror = makeMirror();
  const store = new BlockStore(mirror);
  for (let i = 1; i <= 55; i += 1) {
    await write(
      mirror,
      `\x1b]133;A\x07$ \x1b]133;B\x07c${i}\r\n\x1b]133;C\x07o${i}\r\n\x1b]133;D;0\x07`,
    );
  }

  const list = (await execute(readTools(context(store)).list_blocks, {})) as {
    id: number;
    command: string;
  }[];

  expect(list).toHaveLength(50);
  expect(list[0]!.id).toBe(6);
  expect(list.at(-1)).toMatchObject({ id: 55, command: 'c55' });
});

test('read_block returns the last output lines as text', async () => {
  const { store } = await oneBlock('a\r\nb\r\nc');

  const block = await execute(readTools(context(store)).read_block, { id: 1, lines: 2 });

  expect(block).toEqual({
    command: 'ls -la',
    exitCode: 0,
    cwd: '/tmp',
    output: 'b\nc',
  });
});

test('read_block defaults to 200 lines and caps at 500', async () => {
  const body = Array.from({ length: 600 }, (_, i) => `L${i + 1}`).join('\r\n');
  const { store } = await oneBlock(body);

  const capped = (await execute(readTools(context(store)).read_block, {
    id: 1,
    lines: 1000,
  })) as { output: string };
  const lines = capped.output.split('\n');
  expect(lines).toHaveLength(500);
  expect(lines[0]).toBe('L101');
  expect(lines.at(-1)).toBe('L600');

  const { store: store2 } = await oneBlock(
    Array.from({ length: 260 }, (_, i) => `N${i + 1}`).join('\r\n'),
  );
  const defaulted = (await execute(readTools(context(store2)).read_block, {
    id: 1,
  })) as { output: string };
  expect(defaulted.output.split('\n')).toHaveLength(200);
  expect(defaulted.output.split('\n')[0]).toBe('N61');
});

test('read_block joins wrapped lines with no newline', async () => {
  const mirror = makeMirror(10);
  const store = new BlockStore(mirror);
  await write(
    mirror,
    '\x1b]133;A\x07$ \x1b]133;B\x07wrap\r\n\x1b]133;C\x07abcdefghijklmno\r\n\x1b]133;D;0\x07',
  );

  const block = (await execute(readTools(context(store)).read_block, {
    id: 1,
  })) as { output: string };

  expect(block.output).toBe('abcdefghijklmno');
});

test('read_block reports an unknown id', async () => {
  const { store } = await oneBlock('a');

  expect(await execute(readTools(context(store)).read_block, { id: 99 })).toEqual({
    error: 'no block 99',
  });
});

test('block tools need shell integration', async () => {
  const tools = readTools(context(null));

  expect(await execute(tools.list_blocks, {})).toEqual({
    error: 'blocks need shell integration',
  });
  expect(await execute(tools.read_block, { id: 1 })).toEqual({
    error: 'blocks need shell integration',
  });
});
