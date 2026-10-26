# Readable Arabic (RTL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arabic reads correctly wherever blockterm draws text: letters joined, RTL runs in visual order, and copy, the agent and the PTY all still see logical text.

**Architecture:**
- One pure module `src/render/rtl.ts` does the work in place over a span of frame cells: it shapes Arabic (in-repo table), resolves bidi levels (`bidi-js`), reorders cells, mirrors brackets, and records the logical row so mouse copy and the cursor can map back.
- `composeFrame` applies it to shell rows in the blocks view.
- `drawPanel` applies it to the transcript, input and card rows.
- `src/rtl-mode.ts` decides on/off from config and the host environment.

**Tech Stack:** TypeScript (Node 24), @xterm/headless, node-pty, vitest, `bidi-js@1.1.0` (new, owner-approved).

**Spec:** `docs/superpowers/specs/2026-10-26-blockterm-arabic-rtl-design.md`

## Global Constraints

- Run node/npm as `fnm exec --using=24.19.0 -- npm.cmd …` / `npx.cmd …` from Git Bash. `npm test` builds first; also run `npm run typecheck`.
- The only new dependency is `"bidi-js": "1.1.0"`, pinned exactly. It is CommonJS, and its only export is a factory: `import bidiFactory from 'bidi-js'; const bidi = bidiFactory();`. It ships types at `src/bidi.d.ts`. Its indices are UTF-16 code units.
- Display only: what the PTY, the model (`src/agent/screen.ts`), copy and approval see stays logical text.
- Shaping never changes a row's cell count. No lam-alef ligature: lam and alef keep their own cells, each in its contextual form. *(Plan's call within the spec's "builder's call".)*
- Fullscreen (alt screen) rows, the mode line and the footer are never reordered.
- Card rows use base direction `ltr`, so key chips stay where they are in key order. Transcript and input rows use `auto` (first strong).
- Paragraph = the row for shell output. Ruling: per-row first-strong instead of per-xterm-logical-line. Reason: block rows are recomposed from the mirror and don't carry wrap links. Ceiling: a wrapped mixed line whose continuation row starts with the other script picks its own base. Upgrade: pass the `isWrapped` chain into `composeBlocks`.
- Transcript paragraphs are the wrapped rows of one segment; the plan uses per-row first-strong (same ruling).
- `rtl` config values: `"auto" | "on" | "off"`. Error copy: `rtl must be "auto", "on" or "off"`.
- Doctor line: name `rtl`, detail `on (Windows Terminal)` / `off (Konsole)` and so on. For win32 without `WT_SESSION` it adds ` — Arabic needs a font with Arabic glyphs, or use Windows Terminal`.

## Review Focus

1. A card payload with Arabic: the `⏎ Enter` chip stays after the text, and approval sends the logical keys (Task 4 test).
2. Arabic and a wide character (`世`, emoji) on one row: the wide cell and its continuation stay a pair, in the right order (Task 1 test).
3. Fullscreen programs: in the alt screen the same Arabic text is drawn untouched (Task 3 test).
4. Copy over a reordered row returns logical, unshaped Arabic (Task 3 test).
5. ASCII-only rows go through the fast path unchanged, so there's no cost and no diff churn (Task 1 test).

---

### Task 1: RTL core

**Files:**
- Create: `src/render/rtl.ts`
- Test: `tests/render/rtl.test.ts`
- Modify: `package.json`, `package-lock.json` (add `bidi-js@1.1.0`)

**Interfaces:**
- Produces:

```ts
export type Base = 'auto' | 'ltr' | 'rtl';
/** Logical cells of a reordered host row plus visual→logical column map (absolute columns). */
export interface LogicalRow { cells: Cell[]; map: number[] }
export function hasRtl(text: string): boolean; // any bidi class R or AL
/** Contextual forms for the Arabic letters in `chars` (logical order); same length, non-Arabic unchanged. */
export function shapeArabic(chars: readonly string[]): string[];
/**
 * Reorders cells[row*frameCols+col .. +width) in place: shape, bidi levels (base), L2 reversal,
 * mirror odd-level brackets. Wide cell + width-0 continuation move as one unit (lead stays left).
 * If the span has no RTL character: no change, no record, returns false.
 * Otherwise records logical.set(row, { cells: <row copy before>, map }) and returns true; map is the
 * identity outside the span.
 */
export function reorderSpan(cells: Cell[], frameCols: number, row: number, col: number, width: number,
  base: Base, logical: Map<number, LogicalRow>): boolean;
/** Visual column for logical column `logicalCol` on a reordered row; `end` when logicalCol is past the text. */
export function visualCol(map: readonly number[], logicalCol: number, end: number): number;
```

- [ ] **Step 1: Add the dependency.** Run `fnm exec --using=24.19.0 -- npm.cmd install --save-exact bidi-js@1.1.0`. Expect `package.json` to show `"bidi-js": "1.1.0"`.

- [ ] **Step 2: Write the failing tests** in `tests/render/rtl.test.ts`. Use a helper `rowOf(text)` that builds width-1 cells (`世` gets width 2 plus a width-0 cell), and a helper `textOf(cells)` that joins `ch`.

```ts
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
  const cells = rowOf('مرحبا'); const logical = new Map();
  expect(reorderSpan(cells, 5, 0, 0, 5, 'auto', logical)).toBe(true);
  expect(textOf(cells)).toBe('ﺎﺒﺣﺮﻣ');
  expect(logical.get(0)!.map).toEqual([4, 3, 2, 1, 0]);
  expect(textOf(logical.get(0)!.cells)).toBe('مرحبا');
});
test('LTR base keeps echo and digits in place', () => {
  const cells = rowOf('echo مرحبا 123'); reorderSpan(cells, 14, 0, 0, 14, 'auto', new Map());
  expect(textOf(cells)).toBe('echo ﺎﺒﺣﺮﻣ 123');
});
test('first-strong RTL base orders mixed words right to left', () => {
  const cells = rowOf('مرحبا hello عالم'); reorderSpan(cells, 16, 0, 0, 16, 'auto', new Map());
  const t = textOf(cells);
  expect(t.startsWith('ﻢ')).toBe(true); // عالم left-most: reversed, its final م comes first
  expect(t.indexOf('hello')).toBeGreaterThan(0);
  expect(t.endsWith('ﻣ')).toBe(true);   // مرحبا right-most: its initial م is the last cell
});
test('brackets mirror inside an RTL run', () => {
  const cells = rowOf('(مر)'); reorderSpan(cells, 4, 0, 0, 4, 'rtl', new Map());
  expect(textOf(cells)[0]).toBe('(');
  expect(textOf(cells)[3]).toBe(')');
});
test('a wide cell stays a lead+continuation pair', () => {
  const cells = rowOf('مر世'); reorderSpan(cells, 4, 0, 0, 4, 'rtl', new Map());
  const lead = cells.findIndex(c => c.ch === '世');
  expect(cells[lead]!.width).toBe(2);
  expect(cells[lead + 1]!.width).toBe(0);
});
test('ASCII rows take the fast path', () => {
  const cells = rowOf('hello'); const before = cells.map(c => ({ ...c })); const logical = new Map();
  expect(reorderSpan(cells, 5, 0, 0, 5, 'auto', logical)).toBe(false);
  expect(cells).toEqual(before); expect(logical.size).toBe(0);
});
test('sgr travels with its character', () => {
  const cells = rowOf('مر'); cells[0]!.sgr = '31'; reorderSpan(cells, 2, 0, 0, 2, 'auto', new Map());
  expect(cells[1]!.sgr).toBe('31');
});
test('visualCol maps logical to visual and end past the text', () => {
  expect(visualCol([1, 0], 1, 2)).toBe(0);
  expect(visualCol([1, 0], 2, 2)).toBe(2);
});
```

- [ ] **Step 3: Run** `fnm exec --using=24.19.0 -- npx.cmd vitest run tests/render/rtl.test.ts`. Expect FAIL (module missing).

- [ ] **Step 4: Implement `src/render/rtl.ts`.**
  - Shaping table: a map from letter to `[isolated, final, initial, medial]` Presentation Forms-B code points, plus a joining type (D dual, R right, U none, T transparent).
    - It covers U+0621–U+064A plus U+067E پ, U+0686 چ, U+0698 ژ, U+06A9 ک, U+06AF گ, U+06CC ی.
    - Harakat U+064B–U+065F and U+0670 are T: they're skipped when looking for neighbours and left unchanged.
  - Bidi:
    - Build a one-code-unit-per-unit string. Substitute a same-class BMP placeholder for a unit whose `ch` isn't a single code unit (`a` for L/neutral, `א` for R).
    - Call `bidi.getEmbeddingLevels(str, base === 'auto' ? undefined : base)`, then apply `bidi.getReorderSegments(str, levels)` flips to the unit array.
    - Mirror with `bidi.getMirroredCharacter` on odd levels.
  - Shape before reordering, using logical order.

- [ ] **Step 5: Run** the test file, then `npm test` and `npm run typecheck`. Expect PASS.

- [ ] **Step 6: Commit** `feat: RTL core — Arabic shaping and bidi reorder over frame cells`

### Task 2: On/off detection, config and doctor

**Files:**
- Create: `src/rtl-mode.ts`
- Modify: `src/config.ts`, `src/doctor.ts`, `README.md` (config table row)
- Test: `tests/rtl-mode.test.ts`, `tests/config.test.ts`, `tests/doctor.test.ts`

**Interfaces:**
- Produces: `Config.rtl?: 'auto' | 'on' | 'off'`; `export function rtlMode(setting: 'auto' | 'on' | 'off' | undefined, env: Record<string, string | undefined>, platform: NodeJS.Platform): { on: boolean; reason: string }`.

- [ ] **Step 1: Write the failing tests.**

```ts
test.each([
  [{ WT_SESSION: 'x' }, 'win32', true, 'Windows Terminal'],
  [{}, 'win32', true, 'Windows console'],
  [{ TERM_PROGRAM: 'vscode' }, 'linux', true, 'VS Code'],
  [{ TERM_PROGRAM: 'iTerm.app' }, 'darwin', true, 'iTerm2'],
  [{ TERM_PROGRAM: 'WezTerm' }, 'linux', true, 'WezTerm'],
  [{ TERM_PROGRAM: 'alacritty' }, 'linux', true, 'Alacritty'],
  [{ VTE_VERSION: '7200' }, 'linux', false, 'VTE does bidi'],
  [{ KONSOLE_VERSION: '230800' }, 'linux', false, 'Konsole does bidi'],
  [{ TERM_PROGRAM: 'mintty' }, 'win32', false, 'mintty does bidi'],
  [{ TERM_PROGRAM: 'Apple_Terminal' }, 'darwin', false, 'Terminal.app does bidi'],
  [{}, 'linux', false, 'unknown terminal'],
])('auto %j on %s', (env, platform, on, reason) => {
  expect(rtlMode('auto', env, platform as NodeJS.Platform)).toEqual({ on, reason });
});
test('on and off override detection', () => {
  expect(rtlMode('on', { VTE_VERSION: '1' }, 'linux')).toEqual({ on: true, reason: 'set in config' });
  expect(rtlMode('off', { WT_SESSION: 'x' }, 'win32')).toEqual({ on: false, reason: 'set in config' });
});
```

- Mode checks run in this order: an explicit setting first, then the bidi hosts (they win over `TERM_PROGRAM=vscode`, e.g. VTE inside VS Code is impossible, but mintty sets both), then the plain hosts.
- `tests/config.test.ts`: `rtl: "on"` round-trips; `rtl: "sideways"` → invalid with `rtl must be "auto", "on" or "off"`.
- `tests/doctor.test.ts`: with env `{ WT_SESSION: 'x' }` on win32 there's a check `{ name: 'rtl', ok: true, detail: 'on (Windows Terminal)' }`. With `{}` on win32 the detail is `on (Windows console) — Arabic needs a font with Arabic glyphs, or use Windows Terminal`. The rtl check is informational, always `ok: true`, and is pushed right after the `shell` check, so it shows even without a config.

- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** Add `rtl` to `validateConfig` / `Config` the way `agentColor` is handled (optional, omitted when undefined). Add a README config-table row: `` `rtl` | Arabic/RTL display: `auto` (default), `on`, `off` ``.
- [ ] **Step 4: Run** the suites, `npm test`, `npm run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `feat: rtl setting with host detection and a doctor line`

### Task 3: Shell area, cursor and copy

**Files:**
- Modify: `src/render/frame.ts`, `src/mouse-select.ts`, `src/app.ts`
- Test: `tests/render/frame.test.ts`, `tests/mouse-select.test.ts`, `tests/app-blocks.test.ts`

**Interfaces:**
- Consumes: `reorderSpan`, `visualCol`, `LogicalRow` (Task 1); `rtlMode` (Task 2).
- Produces:
  - `Chrome.rtl?: boolean`.
  - `Frame.logical?: Map<number, LogicalRow>`, keyed by host row. It's always set to a Map (possibly empty) by `composeFrame`.
  - `selectedText` reads logical cells for rows present in `frame.logical`.

- [ ] **Step 1: Write the failing tests.**
  - `frame.test.ts`, through the existing mirror helpers:
    - with `chrome.rtl: true` and the normal screen, writing `echo مرحبا\r\n` then `مرحبا` makes the row show `ﺎﺒﺣﺮﻣ`, and `frame.logical.get(row).cells` joins to `مرحبا`;
    - with `\x1b[?1049h` (alt screen) the same text stays unshaped and in logical order, and `frame.logical.size === 0`;
    - with `chrome.rtl` false or missing, nothing changes.
  - Cursor: the mirror line `مر` with the cursor at x=2 gives frame cursor col 2 (end). After `\x1b[D` (cursor x=1, on `ر`) the frame cursor col is 0.
  - `mouse-select.test.ts`: a frame whose row 0 is reordered (built with `reorderSpan`) and a selection over visual cols 0..4 gives `selectedText` === `مرحبا`. Highlight still reverses visual cells 0..4.
  - `app-blocks.test.ts`: the app decides `rtl` once from `rtlMode(config?.rtl, process.env, process.platform)`. Inject the env through the existing harness options if it has one; otherwise add an `rtl?: boolean` app option used by tests. Dragging over Arabic shell output calls `copy` with logical `مرحبا`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.**
  - `composeFrame`: if `chrome.rtl` and `chrome.view === 'blocks'`, call `reorderSpan(cells, cols, r, left, layout.pty.cols, 'auto', logical)` for each shell row. Then, if the cursor row is in `logical`, set `cursor.col = visualCol(map, cursor.col, <cursor.col>)`. Here `end` is the cursor's own column, so an end-of-run cursor stays put.
  - `selectedText`: for a row in `frame.logical`, take the logical columns `map[c]` of the selected visual columns, then read `logical.cells` over `min..max` of those (skip width-0, trim trailing spaces). ponytail: a partial selection inside a mixed row copies the covering logical span.
  - `app.ts`: compute `rtl` once at start. Pass `rtl` in the chrome.
- [ ] **Step 4: Run** the suites, `npm test`, `npm run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `feat: draw Arabic shell output right to left in the blocks view`

### Task 4: Agent panel

**Files:**
- Modify: `src/render/panel.ts`, `src/app.ts`, `README.md`
- Test: `tests/render/panel.test.ts`, `tests/app-agent.test.ts`

**Interfaces:**
- Consumes: `reorderSpan`, `visualCol` (Task 1); `Frame.logical` (Task 3).
- Produces: `PanelView.rtl?: boolean`. `drawPanel(cells, frameCols, rect, ui, transcript, card, logical?: Map<number, LogicalRow>)` gains an optional last parameter. `app.ts` passes `frame.logical`.

- [ ] **Step 1: Write the failing tests** in `panel.test.ts` (with `rtl: true`, `RECT` 40 cols):
  - A transcript entry `{ who: 'agent', text: 'مرحبا hello عالم' }` draws a row where `hello` sits between the two Arabic words and the row ends (right side) with `ﻣ`.
  - Input `مر`, cursor undefined (end): the input cells after the prompt show `ﺮﻣ`, and the cursor col is promptWidth + 2. With `cursor: 1`, the cursor col is promptWidth + 0 (the cell of `ر`).
  - Card `{ target: 'pwsh', tokens: displayTokens(parseKeys('مرحبا<Enter>').tokens) }`: the payload row reads `▌   ` + `ﺎﺒﺣﺮﻣ` + `  ⏎ Enter`, with the chip still right of the text.
  - `rtl` false: the Arabic input stays logical and unshaped (today's behavior).
  - `app-agent.test.ts`: a card with keys `مرحبا<Enter>` approved with `y` after 450 ms writes `مرحبا\r` (logical) to the PTY.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.**
  - In `drawPanel`, when `ui.rtl`, after drawing:
    - transcript rows: `reorderSpan(..., innerCol, innerCols, 'auto', logical)`;
    - input rows: the span starts after the prompt on the first row and after the indent on the others, base `'auto'`;
    - card rows: the span is the whole row after the gutter, base `'ltr'`.
  - Use a local Map when `logical` isn't passed.
  - Map the input cursor with `visualCol` per the spec's cursor rule, where `end` = the column right of the last input cell.
  - README: one sentence under the agent section, saying Arabic and other RTL text is drawn joined and right to left in hosts without their own bidi support (setting `rtl`).
- [ ] **Step 4: Run** the suites, `npm test`, `npm run typecheck`. Expect PASS.
- [ ] **Step 5: Manual check (orchestrator) in Windows Terminal:**
  - Ask the agent `اكتب مرحبا` and confirm the reply reads correctly.
  - Type Arabic on the agent line and move with ←/→.
  - Run `echo مرحبا` and confirm the output reads correctly.
  - Drag-copy that output and paste it into Notepad: it should be normal Arabic.
- [ ] **Step 6: Commit** `feat: Arabic in the agent panel — transcript, input and card`
