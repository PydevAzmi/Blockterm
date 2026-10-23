import { generateText, type LanguageModel } from 'ai';

import type { Block } from '../blocks/store.js';
import { snapText } from './tools.js';

export interface OneShotContext {
  os: NodeJS.Platform;
  shell: string;
  folder: string | null;
}

const SUGGEST_SYSTEM =
  'You turn a request into one shell command. Reply with the command only: no explanation, no code fences.';
const EXPLAIN_SYSTEM =
  'You explain why a shell command failed and how to fix it. Be brief: the cause in one or two sentences, then the fix.';
const EXPLAIN_LINES = 200;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

function systemPrompt(intro: string, ctx: OneShotContext): string {
  return `${intro}\nOS: ${ctx.os}\nShell: ${ctx.shell}\nFolder: ${ctx.folder ?? 'unknown'}`;
}

// Providers may ignore abortSignal, so the abort itself must settle the call.
function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener('abort', onAbort!));
}

export function cleanSuggestion(text: string): string {
  const candidate = text
    .split(/\r\n|\r|\n/)
    .filter(line => !line.trimStart().startsWith('```'))
    .find(line => line.trim() !== '');
  if (candidate === undefined) return '';

  let out = candidate.replace(CONTROL, '').trim();
  if (out.startsWith('$ ')) out = out.slice(2);
  else if (out.startsWith('> ')) out = out.slice(2);
  if (out.length >= 2 && out.startsWith('`') && out.endsWith('`')) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

export async function suggestCommand(o: {
  model: LanguageModel;
  ctx: OneShotContext;
  request: string;
  signal: AbortSignal;
}): Promise<string> {
  const result = await untilAborted(
    o.signal,
    generateText({
      model: o.model,
      system: systemPrompt(SUGGEST_SYSTEM, o.ctx),
      prompt: o.request,
      abortSignal: o.signal,
    }),
  );
  return cleanSuggestion(result.text);
}

export function explainRequest(block: Block): string {
  const lines = snapText(block.lines).slice(-EXPLAIN_LINES);
  return (
    `Command: ${block.command}\n` +
    `Exit code: ${block.exitCode ?? 'unknown'}\n` +
    `Last output lines:\n${lines.join('\n')}`
  );
}

export async function explainError(o: {
  model: LanguageModel;
  ctx: OneShotContext;
  block: Block;
  signal: AbortSignal;
}): Promise<string> {
  const result = await untilAborted(
    o.signal,
    generateText({
      model: o.model,
      system: systemPrompt(EXPLAIN_SYSTEM, o.ctx),
      prompt: explainRequest(o.block),
      abortSignal: o.signal,
    }),
  );
  return result.text.trim();
}
