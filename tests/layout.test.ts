import { expect, test } from 'vitest';

import { computeLayout } from '../src/layout.js';

test('pty is host minus chrome', () =>
  expect(computeLayout({ cols: 120, rows: 40 })).toEqual({
    host: { cols: 120, rows: 40 },
    pty: { cols: 116, rows: 37 },
    origin: { row: 1, col: 2 },
    panel: { mode: 'hidden', rect: null },
  }));
test('tiny host clamps to 1x1', () =>
  expect(computeLayout({ cols: 3, rows: 2 }).pty).toEqual({ cols: 1, rows: 1 }));
test('closed panel is hidden with a null rect', () =>
  expect(computeLayout({ cols: 120, rows: 40 }, false).panel).toEqual({ mode: 'hidden', rect: null }));
test('docked panel keeps the pty at least 60 cols and sits to its right', () =>
  expect(computeLayout({ cols: 200, rows: 50 }, true)).toEqual({
    host: { cols: 200, rows: 50 },
    pty: { cols: 136, rows: 47 },
    origin: { row: 1, col: 2 },
    panel: { mode: 'docked', rect: { row: 1, col: 140, rows: 47, cols: 60 } },
  }));
test('overlay covers the full width when docking would starve the pty', () =>
  expect(computeLayout({ cols: 90, rows: 30 }, true)).toEqual({
    host: { cols: 90, rows: 30 },
    pty: { cols: 86, rows: 27 },
    origin: { row: 1, col: 2 },
    panel: { mode: 'overlay', rect: { row: 1, col: 1, rows: 27, cols: 88 } },
  }));
test('tiny host with the panel open never produces a negative size', () => {
  const l = computeLayout({ cols: 10, rows: 4 }, true);
  expect(l.pty.cols).toBeGreaterThanOrEqual(1);
  expect(l.pty.rows).toBeGreaterThanOrEqual(1);
  expect(l.panel.rect).not.toBeNull();
  expect(l.panel.rect?.cols).toBeGreaterThanOrEqual(0);
  expect(l.panel.rect?.rows).toBeGreaterThanOrEqual(0);
});
