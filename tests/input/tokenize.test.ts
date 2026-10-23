import { expect, test } from 'vitest';

import { InputTokenizer } from '../../src/input/tokenize.js';

test('plain bytes pass through unchanged', () => {
  expect(new InputTokenizer().push('ls\r')).toEqual([{ type: 'bytes', data: 'ls\r' }]);
});

test('ctrl+c passes through as bytes', () => {
  expect(new InputTokenizer().push('\x03')).toEqual([{ type: 'bytes', data: '\x03' }]);
});

test('ctrl+k is agent-key and splits surrounding bytes', () => {
  expect(new InputTokenizer().push('a\x0bb')).toEqual([
    { type: 'bytes', data: 'a' },
    { type: 'agent-key' },
    { type: 'bytes', data: 'b' },
  ]);
});

test('F1 is help-key in both encodings', () => {
  expect(new InputTokenizer().push('\x1bOP')).toEqual([{ type: 'help-key' }]);
  expect(new InputTokenizer().push('\x1b[11~')).toEqual([{ type: 'help-key' }]);
});

test('shift+page keys are recognised across pushes', () => {
  expect(new InputTokenizer().push('\x1b[5;2~')).toEqual([
    { type: 'page-key', direction: 'up', data: '\x1b[5;2~' },
  ]);
  expect(new InputTokenizer().push('\x1b[6;2~')).toEqual([
    { type: 'page-key', direction: 'down', data: '\x1b[6;2~' },
  ]);

  const t = new InputTokenizer();
  expect(t.push('\x1b[5;')).toEqual([]);
  expect(t.push('2~')).toEqual([{ type: 'page-key', direction: 'up', data: '\x1b[5;2~' }]);
});

test('SGR mouse press', () => {
  expect(new InputTokenizer().push('\x1b[<0;10;5M')).toEqual([
    { type: 'mouse', button: 0, col: 9, row: 4, action: 'press' },
  ]);
});

test('SGR mouse release', () => {
  expect(new InputTokenizer().push('\x1b[<0;10;5m')).toEqual([
    { type: 'mouse', button: 0, col: 9, row: 4, action: 'release' },
  ]);
});

test('SGR mouse motion when bit 32 is set', () => {
  expect(new InputTokenizer().push('\x1b[<32;10;5M')).toEqual([
    { type: 'mouse', button: 32, col: 9, row: 4, action: 'motion' },
  ]);
});

test('SGR mouse wheel is press', () => {
  expect(new InputTokenizer().push('\x1b[<64;1;1M')).toEqual([
    { type: 'mouse', button: 64, col: 0, row: 0, action: 'press' },
  ]);
});

test('bracketed paste keeps its content literal', () => {
  expect(new InputTokenizer().push('\x1b[200~hi\x0b\x1b[201~')).toEqual([
    { type: 'paste', text: 'hi\x0b' },
  ]);
});

test('bracketed paste held across pushes', () => {
  const t = new InputTokenizer();
  expect(t.push('\x1b[200~h')).toEqual([]);
  expect(t.push('i\x1b[201~')).toEqual([{ type: 'paste', text: 'hi' }]);
});

test('focus events', () => {
  expect(new InputTokenizer().push('\x1b[I')).toEqual([{ type: 'focus', focused: true }]);
  expect(new InputTokenizer().push('\x1b[O')).toEqual([{ type: 'focus', focused: false }]);
});

test('SGR mouse held across pushes', () => {
  const t = new InputTokenizer();
  expect(t.push('\x1b[<0;1')).toEqual([]);
  expect(t.push('0;5M')).toEqual([
    { type: 'mouse', button: 0, col: 9, row: 4, action: 'press' },
  ]);
});

test('trailing lone ESC is held then flushed as bytes', () => {
  const t = new InputTokenizer();
  expect(t.push('\x1b')).toEqual([]);
  expect(t.flush()).toEqual([{ type: 'bytes', data: '\x1b' }]);
});

test('complete non-ours escape is emitted as bytes', () => {
  expect(new InputTokenizer().push('\x1b[A')).toEqual([{ type: 'bytes', data: '\x1b[A' }]);
  expect(new InputTokenizer().push('\x1b[1;5C')).toEqual([{ type: 'bytes', data: '\x1b[1;5C' }]);
});

test('trailing prefix of our forms is held', () => {
  for (const prefix of ['\x1b[', '\x1bO', '\x1b[1', '\x1b[20']) {
    const t = new InputTokenizer();
    expect(t.push(prefix)).toEqual([]);
    expect(t.flush()).toEqual([{ type: 'bytes', data: prefix }]);
  }
});

test('flush is a no-op during an unfinished paste', () => {
  const t = new InputTokenizer();
  expect(t.push('\x1b[200~ab\x1b[20')).toEqual([]);
  expect(t.flush()).toEqual([]);
  expect(t.push('1~')).toEqual([{ type: 'paste', text: 'ab' }]);
  expect(t.push('x')).toEqual([{ type: 'bytes', data: 'x' }]);
});

test('paste end marker split across pushes', () => {
  const t = new InputTokenizer();
  expect(t.push('\x1b[200~hi\x1b[20')).toEqual([]);
  expect(t.push('1~')).toEqual([{ type: 'paste', text: 'hi' }]);
});

test('SGR mouse with empty or non-numeric fields is bytes', () => {
  expect(new InputTokenizer().push('\x1b[<;;M')).toEqual([{ type: 'bytes', data: '\x1b[<;;M' }]);
  expect(new InputTokenizer().push('\x1b[<0;5M')).toEqual([{ type: 'bytes', data: '\x1b[<0;5M' }]);
  expect(new InputTokenizer().push('\x1b[<abcM')).toEqual([{ type: 'bytes', data: '\x1b[<abcM' }]);
});

test('over-long held mouse prefix is emitted as bytes', () => {
  const long = '\x1b[<' + '1'.repeat(40);
  expect(new InputTokenizer().push(long)).toEqual([{ type: 'bytes', data: long }]);
});

test('held escape prefixes resolve with the next push', () => {
  const bracket = new InputTokenizer();
  expect(bracket.push('\x1b[')).toEqual([]);
  expect(bracket.push('A')).toEqual([{ type: 'bytes', data: '\x1b[A' }]);

  const esc = new InputTokenizer();
  expect(esc.push('\x1b')).toEqual([]);
  expect(esc.push('x')).toEqual([{ type: 'bytes', data: '\x1bx' }]);
});

test('non-ours escapes are not delayed', () => {
  expect(new InputTokenizer().push('\x1bjk')).toEqual([{ type: 'bytes', data: '\x1bjk' }]);
  expect(new InputTokenizer().push('\x1b[15~')).toEqual([{ type: 'bytes', data: '\x1b[15~' }]);
});
