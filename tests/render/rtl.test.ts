import { expect, test } from 'vitest';

import type { Cell } from '../../src/render/frame.js';
import {
  reorderSpan,
  shapeArabic,
  visualCol,
  type LogicalRow,
} from '../../src/render/rtl.js';

function rowOf(text: string): Cell[] {
  const cells: Cell[] = [];
  for (const ch of Array.from(text)) {
    const width: 1 | 2 = ch === '世' ? 2 : 1;
    cells.push({ ch, width, sgr: '' });
    if (width === 2) cells.push({ ch: '', width: 0, sgr: '' });
  }
  return cells;
}

function textOf(cells: readonly Cell[]): string {
  return cells.map(c => c.ch).join('');
}

test('shapeArabic gives contextual forms for مرحبا', () => {
  expect(shapeArabic(Array.from('مرحبا')).join('')).toBe('ﻣﺮﺣﺒﺎ');
});

test('isolated letters and non-Arabic pass through', () => {
  expect(shapeArabic(Array.from('م a')).join('')).toBe('ﻡ a');
});

test('lam-alef keeps two cells', () => {
  expect(shapeArabic(Array.from('لا'))).toHaveLength(2);
});

test('a pure Arabic span is shaped and reversed, same cell count', () => {
  const cells = rowOf('مرحبا');
  const logical = new Map<number, LogicalRow>();
  expect(reorderSpan(cells, 5, 0, 0, 5, 'auto', logical)).toBe(true);
  expect(textOf(cells)).toBe('ﺎﺒﺣﺮﻣ');
  expect(logical.get(0)!.map).toEqual([4, 3, 2, 1, 0]);
  expect(textOf(logical.get(0)!.cells)).toBe('مرحبا');
});

test('LTR base keeps echo and digits in place', () => {
  const cells = rowOf('echo مرحبا 123');
  reorderSpan(cells, 14, 0, 0, 14, 'auto', new Map());
  expect(textOf(cells)).toBe('echo 123 ﺎﺒﺣﺮﻣ');
});

test('first-strong RTL base orders mixed words right to left', () => {
  const cells = rowOf('مرحبا hello عالم');
  reorderSpan(cells, 16, 0, 0, 16, 'auto', new Map());
  const t = textOf(cells);
  expect(t.startsWith('ﻢ')).toBe(true); // عالم left-most: reversed, its final م comes first
  expect(t.indexOf('hello')).toBeGreaterThan(0);
  expect(t.endsWith('ﻣ')).toBe(true); // مرحبا right-most: its initial م is the last cell
});

test('brackets mirror inside an RTL run', () => {
  const cells = rowOf('(مر)');
  reorderSpan(cells, 4, 0, 0, 4, 'rtl', new Map());
  expect(textOf(cells)[0]).toBe('(');
  expect(textOf(cells)[3]).toBe(')');
});

test('a wide cell stays a lead+continuation pair', () => {
  const cells = rowOf('مر世');
  reorderSpan(cells, 4, 0, 0, 4, 'rtl', new Map());
  const lead = cells.findIndex(c => c.ch === '世');
  expect(cells[lead]!.width).toBe(2);
  expect(cells[lead + 1]!.width).toBe(0);
});

test('ASCII rows take the fast path', () => {
  const cells = rowOf('hello');
  const before = cells.map(c => ({ ...c }));
  const logical = new Map<number, LogicalRow>();
  expect(reorderSpan(cells, 5, 0, 0, 5, 'auto', logical)).toBe(false);
  expect(cells).toEqual(before);
  expect(logical.size).toBe(0);
});

test('sgr travels with its character', () => {
  const cells = rowOf('مر');
  cells[0]!.sgr = '31';
  reorderSpan(cells, 2, 0, 0, 2, 'auto', new Map());
  expect(cells[1]!.sgr).toBe('31');
});

test('visualCol maps logical to visual and end past the text', () => {
  expect(visualCol([1, 0], 1, 2)).toBe(0);
  expect(visualCol([1, 0], 2, 2)).toBe(2);
});
