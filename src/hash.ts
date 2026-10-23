import type { InputEvent } from './input/tokenize.js';

export interface HashState {
  input: string;
  status: 'editing' | 'busy' | { error: string };
}

export type HashAction = null | { type: 'submit'; request: string } | { type: 'close' };

const ESC = '\x1b';
const DEL = '\x7f';
const BS = '\b';

function isPrintable(ch: string): boolean {
  return ch >= ' ' && ch !== DEL;
}

export function stripControl(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

function deleteLast(text: string): string {
  const points = Array.from(text);
  points.pop();
  return points.join('');
}

function bytes(s: HashState, data: string): { state: HashState; action: HashAction } {
  if (data === ESC) return { state: s, action: { type: 'close' } };
  if (data.startsWith(ESC)) return { state: s, action: null };
  if (s.status !== 'editing') return { state: s, action: null };

  let input = s.input;
  for (const ch of Array.from(data)) {
    if (ch === DEL || ch === BS) {
      input = deleteLast(input);
    } else if (ch === '\r' || ch === '\n') {
      if (input.trim() === '') return { state: s, action: { type: 'close' } };
      return {
        state: { input, status: 'busy' },
        action: { type: 'submit', request: input.trim() },
      };
    } else if (isPrintable(ch)) {
      input += stripControl(ch);
    }
  }
  return { state: { ...s, input }, action: null };
}

export function reduceHash(
  s: HashState,
  e: InputEvent,
): { state: HashState; action: HashAction } {
  switch (e.type) {
    case 'bytes':
      return bytes(s, e.data);
    case 'paste':
      if (s.status !== 'editing') return { state: s, action: null };
      return {
        state: { ...s, input: s.input + stripControl(e.text.replace(/[\r\n]/g, ' ')) },
        action: null,
      };
    default:
      return { state: s, action: null };
  }
}
