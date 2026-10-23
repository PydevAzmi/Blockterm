import { expect, test } from 'vitest';

import { reduceHash, type HashState } from '../src/hash.js';
import type { InputEvent } from '../src/input/tokenize.js';

function editing(input = ''): HashState {
  return { input, status: 'editing' };
}

function bytes(data: string): InputEvent {
  return { type: 'bytes', data };
}

test('printable bytes append and backspace deletes one code point', () => {
  const typed = reduceHash(editing(), bytes('ab😀'));
  expect(typed.state).toEqual(editing('ab😀'));

  expect(reduceHash(typed.state, bytes('\x7f')).state).toEqual(editing('ab'));
  expect(reduceHash(editing('ab'), bytes('\b')).state).toEqual(editing('a'));
});

test('paste appends with CR and LF replaced by spaces', () => {
  const result = reduceHash(editing('echo '), { type: 'paste', text: 'a\r\nb\nc' });
  expect(result.state).toEqual(editing('echo a  b c'));
  expect(result.action).toBeNull();
});

test('enter submits the trimmed request and marks the input busy', () => {
  const result = reduceHash(editing('  list big files  '), bytes('\r'));
  expect(result.action).toEqual({ type: 'submit', request: 'list big files' });
  expect(result.state.status).toBe('busy');
});

test('enter with a blank request closes the input', () => {
  expect(reduceHash(editing('   '), bytes('\r'))).toEqual({
    state: editing('   '),
    action: { type: 'close' },
  });
});

test('escape closes the input in every status', () => {
  const states: HashState[] = [
    editing('ls'),
    { input: 'ls', status: 'busy' },
    { input: 'ls', status: { error: 'boom' } },
  ];
  for (const state of states) {
    expect(reduceHash(state, bytes('\x1b'))).toEqual({
      state,
      action: { type: 'close' },
    });
  }
});

test('keys other than escape are ignored while busy or showing an error', () => {
  const busy: HashState = { input: 'ls', status: 'busy' };
  const failed: HashState = { input: 'ls', status: { error: 'boom' } };

  for (const event of [bytes('x'), bytes('\r'), bytes('\x7f'), { type: 'paste' as const, text: 'y' }]) {
    expect(reduceHash(busy, event)).toEqual({ state: busy, action: null });
    expect(reduceHash(failed, event)).toEqual({ state: failed, action: null });
  }
});

test('control characters are stripped from typed and pasted input', () => {
  expect(reduceHash(editing('a'), bytes('\x01b\x9b')).state).toEqual(editing('ab'));
  expect(
    reduceHash(editing('echo '), { type: 'paste', text: 'x\x00\t\x7f\x9b\r\n' }).state,
  ).toEqual(editing('echo x  '));
});
