import { expect, test } from 'vitest';

import { moveSelection, selectionKey } from '../src/selection.js';

test('selectionKey maps ctrl+arrows to prev and next', () => {
  expect(selectionKey('\x1b[1;5A')).toBe('prev');
  expect(selectionKey('\x1b[1;5B')).toBe('next');
});

test('selectionKey maps the block action keys', () => {
  expect(selectionKey('c')).toBe('copy-command');
  expect(selectionKey('o')).toBe('copy-output');
  expect(selectionKey('r')).toBe('rerun');
  expect(selectionKey('e')).toBe('explain');
});

test('selectionKey maps Enter and Esc to exit', () => {
  expect(selectionKey('\r')).toBe('exit');
  expect(selectionKey('\x1b')).toBe('exit');
});

test('selectionKey maps the scroll keys', () => {
  expect(selectionKey('\x1b[5~')).toBe('scroll-page-up');
  expect(selectionKey('\x1b[6~')).toBe('scroll-page-down');
  expect(selectionKey('\x1b[H')).toBe('scroll-top');
  expect(selectionKey('\x1b[F')).toBe('scroll-bottom');
  expect(selectionKey('\x1b[1~')).toBe('scroll-top');
  expect(selectionKey('\x1bOH')).toBe('scroll-top');
  expect(selectionKey('\x1bOF')).toBe('scroll-bottom');
  expect(selectionKey('constructor')).toBeNull();
  expect(selectionKey('__proto__')).toBeNull();
  expect(selectionKey('\x1b[4~')).toBe('scroll-bottom');
});

test('selectionKey drops unknown keys', () => {
  expect(selectionKey('x')).toBeNull();
  expect(selectionKey('\x03')).toBeNull();
  expect(selectionKey('co')).toBeNull();
});

test('moveSelection starts at the newest block and walks older', () => {
  expect(moveSelection([1, 2, 3], null, 'prev')).toBe(3);
  expect(moveSelection([1, 2, 3], 3, 'prev')).toBe(2);
  expect(moveSelection([1, 2, 3], 1, 'prev')).toBe(1);
});

test('moveSelection past the newest clears the selection', () => {
  expect(moveSelection([1, 2, 3], 3, 'next')).toBeNull();
  expect(moveSelection([1, 2, 3], 2, 'next')).toBe(3);
});

test('moveSelection handles empty ids and stale ids', () => {
  expect(moveSelection([], null, 'prev')).toBeNull();
  expect(moveSelection([], null, 'next')).toBeNull();
  expect(moveSelection([1, 2, 3], 9, 'prev')).toBe(3);
  expect(moveSelection([1, 2, 3], 9, 'next')).toBeNull();
});
