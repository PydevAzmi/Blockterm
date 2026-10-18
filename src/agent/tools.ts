import { jsonSchema, tool, type ToolSet } from 'ai';

import { readScreen, readScrollback, waitForQuiet } from './screen.js';
import type { TerminalSession } from '../term/session.js';

export interface ToolContext {
  session: TerminalSession;
  appCursor: () => boolean;
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
