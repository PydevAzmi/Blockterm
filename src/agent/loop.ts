import { streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';

import { keysToBytes, parseKeys } from './keys.js';
import { redact } from './model.js';
import { readTools, writeTools, type ToolContext } from './tools.js';

export type Decision =
  | { kind: 'approve'; keys: string; allowRest: boolean }
  | { kind: 'deny'; reason: string };

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'approval'; keys: string; target: string }
  | { type: 'sent'; keys: string; auto: boolean }
  | { type: 'done' }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }
  | { type: 'limit'; message: string };

export interface TaskOptions {
  model: LanguageModel;
  system: string;
  history: ModelMessage[];
  prompt: string;
  ctx: ToolContext;
  target: () => string;
  approve: (keys: string) => Promise<Decision>;
  onEvent: (e: AgentEvent) => void;
  signal: AbortSignal;
  secrets: string[];
  now?: () => number;
  maxToolCalls?: number;
  maxMs?: number;
}

type SendResult =
  | { status: 'error'; message: string }
  | { status: 'done'; sent: string; edited: boolean }
  | { status: 'denied'; reason: string };

type ToolOutcome = SendResult | { status: 'cancelled' };

const DEFAULT_MAX_TOOL_CALLS = 25;
const DEFAULT_MAX_MS = 10 * 60 * 1000;
const ABORTED = 'blockterm: aborted';

function abortError(): Error {
  const error = new Error(ABORTED);
  error.name = 'AbortError';
  return error;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

function redactEvent(event: AgentEvent, secrets: string[]): AgentEvent {
  switch (event.type) {
    case 'text':
      return { type: 'text', delta: redact(event.delta, secrets) };
    case 'error':
      return { type: 'error', message: redact(event.message, secrets) };
    case 'approval':
      return { type: 'approval', keys: redact(event.keys, secrets), target: event.target };
    case 'sent':
      return { type: 'sent', keys: redact(event.keys, secrets), auto: event.auto };
    default:
      return event;
  }
}

export async function runTask(o: TaskOptions): Promise<ModelMessage[]> {
  const secrets = o.secrets;
  const now = o.now ?? ((): number => Date.now());
  const maxToolCalls = o.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxMs = o.maxMs ?? DEFAULT_MAX_MS;

  const emit = (event: AgentEvent): void => o.onEvent(redactEvent(event, secrets));
  const messages: ModelMessage[] = [...o.history, { role: 'user', content: o.prompt }];
  const start = now();

  const reads = readTools(o.ctx);
  const tools: ToolSet = { ...reads, ...writeTools() };
  const readNames = new Set(Object.keys(reads));

  let used = 0;
  let allowRest = false;

  const abortIfNeeded = (): boolean => {
    if (o.signal.aborted) {
      emit({ type: 'cancelled' });
      return true;
    }
    return false;
  };

  const awaitDecision = async (keys: string): Promise<Decision | 'abort'> => {
    emit({ type: 'approval', keys, target: o.target() });
    if (o.signal.aborted) return 'abort';
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<Decision>((_, reject) => {
      onAbort = (): void => reject(abortError());
      o.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([o.approve(keys), aborted]);
    } catch (error) {
      if (isAbort(error, o.signal)) return 'abort';
      throw error;
    } finally {
      if (onAbort !== undefined) o.signal.removeEventListener('abort', onAbort);
    }
  };

  const handleSendKeys = async (rawInput: unknown): Promise<SendResult | 'abort'> => {
    const keys =
      typeof rawInput === 'object' && rawInput !== null && 'keys' in rawInput
        ? String((rawInput as { keys: unknown }).keys)
        : '';
    const parsed = parseKeys(keys);
    if (!parsed.ok) return { status: 'error', message: parsed.message };

    if (allowRest) {
      const bytes = keysToBytes(parsed.tokens, o.ctx.appCursor());
      o.ctx.session.write(bytes);
      emit({ type: 'sent', keys, auto: true });
      return { status: 'done', sent: bytes, edited: false };
    }

    const decision = await awaitDecision(keys);
    if (decision === 'abort') return 'abort';
    if (decision.kind === 'deny') return { status: 'denied', reason: decision.reason };

    const chosen = parseKeys(decision.keys);
    if (!chosen.ok) return { status: 'error', message: chosen.message };
    if (decision.allowRest) allowRest = true;

    const bytes = keysToBytes(chosen.tokens, o.ctx.appCursor());
    o.ctx.session.write(bytes);
    emit({ type: 'sent', keys: decision.keys, auto: false });
    return { status: 'done', sent: bytes, edited: decision.keys !== keys };
  };

  try {
    for (;;) {
      if (abortIfNeeded()) return messages;
      if (now() - start > maxMs) {
        emit({ type: 'limit', message: 'stopped: 10 minute limit' });
        return messages;
      }
      if (used >= maxToolCalls) {
        emit({ type: 'limit', message: `stopped: ${maxToolCalls} tool calls` });
        return messages;
      }

      const usedAtStart = used;
      const result = streamText({
        model: o.model,
        system: o.system,
        messages,
        tools,
        stopWhen: ({ steps }) =>
          now() - start > maxMs ||
          usedAtStart + steps.reduce((total, step) => total + step.toolCalls.length, 0) >=
            maxToolCalls,
        abortSignal: o.signal,
        // Errors are reported to the caller via events; never log the raw error
        // (the SDK default prints it, including secrets, to the terminal).
        onError: () => {},
      });

      let callsThisCall = 0;
      const pending: { toolCallId: string; input: unknown }[] = [];
      let streamError: string | undefined;

      try {
        for await (const part of result.stream) {
          if (part.type === 'text-delta') {
            emit({ type: 'text', delta: part.text });
          } else if (part.type === 'tool-call') {
            callsThisCall += 1;
            // Invalid calls already have an error result recorded by the SDK.
            if (part.invalid !== true) {
              if (part.toolName === 'send_keys') {
                pending.push({ toolCallId: part.toolCallId, input: part.input });
              } else if (readNames.has(part.toolName)) {
                emit({ type: 'tool', name: part.toolName });
              }
            }
          } else if (part.type === 'error') {
            streamError = messageOf(part.error);
          }
        }
      } catch (error) {
        if (isAbort(error, o.signal)) {
          emit({ type: 'cancelled' });
          return messages;
        }
        emit({ type: 'error', message: streamError ?? messageOf(error) });
        return messages;
      }

      if (streamError !== undefined) {
        emit({ type: 'error', message: streamError });
        return messages;
      }

      const finishReason = await result.finishReason;
      messages.push(...(await result.responseMessages));
      used = usedAtStart + callsThisCall;

      if (pending.length === 0) {
        if (finishReason !== 'tool-calls' || callsThisCall === 0) {
          emit({ type: 'done' });
          return messages;
        }
        continue;
      }

      const results: {
        type: 'tool-result';
        toolCallId: string;
        toolName: 'send_keys';
        output: { type: 'json'; value: ToolOutcome };
      }[] = [];
      const pushResults = (): void => {
        messages.push({ role: 'tool', content: results });
      };
      const resultFor = (toolCallId: string, value: ToolOutcome): (typeof results)[number] => ({
        type: 'tool-result',
        toolCallId,
        toolName: 'send_keys',
        output: { type: 'json', value },
      });

      for (let index = 0; index < pending.length; index += 1) {
        const call = pending[index]!;
        let outcome: SendResult | 'abort';
        try {
          outcome = await handleSendKeys(call.input);
        } catch (error) {
          const message = messageOf(error);
          for (let rest = index; rest < pending.length; rest += 1) {
            results.push(resultFor(pending[rest]!.toolCallId, { status: 'error', message }));
          }
          pushResults();
          if (isAbort(error, o.signal)) emit({ type: 'cancelled' });
          else emit({ type: 'error', message });
          return messages;
        }
        if (outcome === 'abort') {
          for (let rest = index; rest < pending.length; rest += 1) {
            results.push(resultFor(pending[rest]!.toolCallId, { status: 'cancelled' }));
          }
          pushResults();
          emit({ type: 'cancelled' });
          return messages;
        }
        results.push(resultFor(call.toolCallId, outcome));
      }
      pushResults();
    }
  } catch (error) {
    if (isAbort(error, o.signal)) emit({ type: 'cancelled' });
    else emit({ type: 'error', message: messageOf(error) });
    return messages;
  }
}
