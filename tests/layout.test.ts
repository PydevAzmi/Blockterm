import { expect, test } from 'vitest';

import { computeLayout } from '../src/layout.js';

test('pty is host minus chrome', () =>
  expect(computeLayout({ cols: 120, rows: 40 })).toEqual({ host: { cols: 120, rows: 40 }, pty: { cols: 116, rows: 37 }, origin: { row: 1, col: 2 } }));
test('tiny host clamps to 1x1', () =>
  expect(computeLayout({ cols: 3, rows: 2 }).pty).toEqual({ cols: 1, rows: 1 }));
