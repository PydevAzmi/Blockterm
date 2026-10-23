import { jsonSchema, tool, type ToolSet } from 'ai';

import type { Block, BlockStore, SnapLine } from '../blocks/store.js';
import { readScreen, readScrollback, waitForQuiet } from './screen.js';
import type { TerminalSession } from '../term/session.js';

export interface ToolContext {
  session: TerminalSession;
  appCursor: () => boolean;
  blocks: BlockStore | null;
}

const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 500;

function snapText(lines: SnapLine[]): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of lines) {
    for (const cell of line.cells) {
      if (cell.width !== 0) current += cell.ch;
    }
    if (!line.wrapped) {
      out.push(current.trimEnd());
      current = '';
    }
  }
  if (current !== '' || (lines.length > 0 && lines[lines.length - 1]!.wrapped)) {
    out.push(current.trimEnd());
  }
  return out;
}

function outputLineCount(lines: SnapLine[]): number {
  let count = 0;
  let open = false;
  for (const line of lines) {
    open = line.wrapped;
    if (!line.wrapped) count += 1;
  }
  if (open) count += 1;
  return count;
}

function blockOutput(block: Block, count: number): string {
  const text = snapText(block.lines);
  const take = Math.min(MAX_READ_LINES, Math.max(0, Math.floor(count)));
  return text.slice(Math.max(0, text.length - take)).join('\n');
}

export function readTools(ctx: ToolContext): ToolSet {
  return {
    read_screen: tool({
      description:
        'Read the visible terminal screen: text, cursor position, view, foreground program and size.',
      inputSchema: jsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: () => readScreen(ctx.session),
    }),
    read_scrollback: tool({
      description: 'Read up to 500 lines from the terminal scrollback history.',
      inputSchema: jsonSchema<{ lines: number }>({
        type: 'object',
        properties: {
          lines: {
            type: 'number',
            description: 'How many lines of history to read (capped at 500).',
          },
        },
        required: ['lines'],
        additionalProperties: false,
      }),
      execute: ({ lines }) => ({ text: readScrollback(ctx.session.mirror, lines) }),
    }),
    list_blocks: tool({
      description:
        'List finished command blocks, newest last (at most 50), with id, command, exit code, cwd and line count.',
      inputSchema: jsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: () => {
        const blocks = ctx.blocks;
        if (blocks === null) return { error: 'blocks need shell integration' };
        return blocks.blocks.slice(-50).map(block => ({
          id: block.id,
          command: block.command,
          exitCode: block.exitCode,
          cwd: block.cwd,
          lines: outputLineCount(block.lines),
        }));
      },
    }),
    read_block: tool({
      description:
        'Read one finished block by id: its command, exit code, cwd and the last output lines as text.',
      inputSchema: jsonSchema<{ id: number; lines?: number }>({
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: 'The block id from list_blocks.',
          },
          lines: {
            type: 'number',
            description: 'How many output lines to read (default 200, capped at 500).',
          },
        },
        required: ['id'],
        additionalProperties: false,
      }),
      execute: ({ id, lines }) => {
        const blocks = ctx.blocks;
        if (blocks === null) return { error: 'blocks need shell integration' };
        const block = blocks.blocks.find(candidate => candidate.id === id);
        if (block === undefined) return { error: `no block ${id}` };
        return {
          command: block.command,
          exitCode: block.exitCode,
          cwd: block.cwd,
          output: blockOutput(block, lines ?? DEFAULT_READ_LINES),
        };
      },
    }),
    wait_for_output: tool({
      description:
        'Wait until terminal output has been quiet for about 400 ms (capped at 15 s), then read the screen.',
      inputSchema: jsonSchema<{ ms: number }>({
        type: 'object',
        properties: {
          ms: {
            type: 'number',
            description: 'Maximum time to wait in milliseconds (capped at 15000).',
          },
        },
        required: ['ms'],
        additionalProperties: false,
      }),
      execute: async ({ ms }, { abortSignal }) => {
        await waitForQuiet(ctx.session, ms, 400, abortSignal);
        return readScreen(ctx.session);
      },
    }),
  };
}

export function writeTools(): ToolSet {
  return {
    run_command: tool({
      description:
        'Run one command as a new block by typing it plus Enter at an idle shell prompt. Use send_keys outside an idle prompt. The user approves, edits or denies each call.',
      inputSchema: jsonSchema<{ command: string }>({
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The command line to run.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      }),
    }),
    send_keys: tool({
      description:
        'Type keys on the user terminal. Text is sent literally; keys are named like <Enter>, <Esc>, <C-c>; write <lt> for a literal <. The user approves, edits or denies each call.',
      inputSchema: jsonSchema<{ keys: string }>({
        type: 'object',
        properties: {
          keys: {
            type: 'string',
            description: 'The keys to send, in blockterm key syntax.',
          },
        },
        required: ['keys'],
        additionalProperties: false,
      }),
    }),
  };
}
