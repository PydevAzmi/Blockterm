import { expect, test } from 'vitest';

import { displayTokens, keysToBytes, parseKeys } from '../../src/agent/keys.js';
import type { KeyToken } from '../../src/agent/keys.js';

function tokens(syntax: string): KeyToken[] {
  const result = parseKeys(syntax);
  if (!result.ok) throw new Error(result.message);
  return result.tokens;
}

function bytes(name: string, appCursor = false): string {
  return keysToBytes([{ kind: 'key', name }], appCursor);
}

test('parseKeys: splits text and a named key', () =>
  expect(parseKeys('ls -la<Enter>')).toEqual({
    ok: true,
    tokens: [
      { kind: 'text', value: 'ls -la' },
      { kind: 'key', name: 'Enter' },
    ],
  }));

test('parseKeys: a > outside a key is literal text', () =>
  expect(parseKeys('a>b')).toEqual({
    ok: true,
    tokens: [{ kind: 'text', value: 'a>b' }],
  }));

test('parseKeys: <lt> is the < key', () =>
  expect(parseKeys('a<lt>b')).toEqual({
    ok: true,
    tokens: [
      { kind: 'text', value: 'a' },
      { kind: 'key', name: 'lt' },
      { kind: 'text', value: 'b' },
    ],
  }));

test('parseKeys: unknown key is an error', () =>
  expect(parseKeys('<Foo>')).toEqual({ ok: false, message: 'unknown key <Foo>' }));

test('parseKeys: empty string is an error', () =>
  expect(parseKeys('')).toEqual({ ok: false, message: 'keys is empty' }));

test('parseKeys: a bare < with no closing > is an error', () => {
  const result = parseKeys('a<b');
  expect(result.ok).toBe(false);
});

test('keysToBytes: simple keys', () => {
  expect(bytes('Enter')).toBe('\r');
  expect(bytes('Esc')).toBe('\x1b');
  expect(bytes('Tab')).toBe('\t');
  expect(bytes('BS')).toBe('\x7f');
  expect(bytes('Space')).toBe(' ');
  expect(bytes('lt')).toBe('<');
  expect(bytes('C-c')).toBe('\x03');
  expect(bytes('C-a')).toBe('\x01');
});

test('keysToBytes: arrows, home and end in normal mode', () => {
  expect(bytes('Up')).toBe('\x1b[A');
  expect(bytes('Down')).toBe('\x1b[B');
  expect(bytes('Right')).toBe('\x1b[C');
  expect(bytes('Left')).toBe('\x1b[D');
  expect(bytes('Home')).toBe('\x1b[H');
  expect(bytes('End')).toBe('\x1b[F');
  expect(bytes('PgUp')).toBe('\x1b[5~');
  expect(bytes('PgDn')).toBe('\x1b[6~');
});

test('keysToBytes: arrows, home and end in app-cursor mode', () => {
  expect(bytes('Up', true)).toBe('\x1bOA');
  expect(bytes('Down', true)).toBe('\x1bOB');
  expect(bytes('Right', true)).toBe('\x1bOC');
  expect(bytes('Left', true)).toBe('\x1bOD');
  expect(bytes('Home', true)).toBe('\x1bOH');
  expect(bytes('End', true)).toBe('\x1bOF');
  expect(bytes('PgUp', true)).toBe('\x1b[5~');
});

test('keysToBytes: joins text and keys', () =>
  expect(keysToBytes(tokens('ls -la<Enter>'), false)).toBe('ls -la\r'));

test('keysToBytes: a control key maps to its control byte', () => {
  expect(bytes('C-b')).toBe('\x02');
  expect(bytes('C-z')).toBe('\x1a');
});

test('displayTokens: escapes control chars in text and labels keys', () =>
  expect(displayTokens(tokens('a\nb<Enter>'))).toEqual([
    { kind: 'text', label: 'a\\x0ab' },
    { kind: 'key', label: '⏎ Enter' },
  ]));

test('displayTokens: special key labels', () => {
  expect(displayTokens(tokens('<Esc>'))).toEqual([{ kind: 'key', label: '⎋ Esc' }]);
  expect(displayTokens(tokens('<Tab>'))).toEqual([{ kind: 'key', label: '⇥ Tab' }]);
  expect(displayTokens(tokens('<C-c>'))).toEqual([{ kind: 'key', label: '^C' }]);
  expect(displayTokens(tokens('<Space>'))).toEqual([{ kind: 'key', label: 'Space' }]);
});
