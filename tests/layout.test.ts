import { expect, test } from 'vitest';

import { computeLayout } from '../src/layout.js';

test('pty takes the full width and every row but the mode line', () =>
  expect(computeLayout({ cols: 120, rows: 40 })).toEqual({
    host: { cols: 120, rows: 40 },
    pty: { cols: 120, rows: 39 },
    origin: { row: 0, col: 0 },
    panel: { mode: 'hidden', rect: null },
  }));
test('tiny host clamps to 1x1', () =>
  expect(computeLayout({ cols: 1, rows: 1 }).pty).toEqual({ cols: 1, rows: 1 }));
test('closed panel is hidden with a null rect', () =>
  expect(computeLayout({ cols: 120, rows: 40 }, false).panel).toEqual({ mode: 'hidden', rect: null }));
test('open agent docks a full-width strip under the pty, ending on the input line', () =>
  expect(computeLayout({ cols: 200, rows: 50 }, true)).toEqual({
    host: { cols: 200, rows: 50 },
    pty: { cols: 200, rows: 39 },
    origin: { row: 0, col: 0 },
    panel: { mode: 'docked', rect: { row: 39, col: 0, rows: 11, cols: 200 } },
  }));
test('the strip is at least two rows above the input line on a short host', () =>
  expect(computeLayout({ cols: 90, rows: 6 }, true).panel.rect).toEqual({ row: 3, col: 0, rows: 3, cols: 90 }));
test('tiny host with the panel open never produces a negative size', () => {
  const l = computeLayout({ cols: 10, rows: 4 }, true);
  expect(l.pty.cols).toBeGreaterThanOrEqual(1);
  expect(l.pty.rows).toBeGreaterThanOrEqual(1);
  expect(l.panel.rect).not.toBeNull();
  expect(l.pty.rows + l.panel.rect!.rows).toBe(4);
});
