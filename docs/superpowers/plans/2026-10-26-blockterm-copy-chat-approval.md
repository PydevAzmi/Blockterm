# Mouse Copy, Prompt Editing, Clear Chat, Approval Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag-to-copy inside blockterm's panes, a cursor and prompt history in the agent input, a way to clear the agent chat, and the "gutter bar" approval card with Enter = approve.

**Architecture:** Prompt editing, history and clear live in the pure reducer `src/focus.ts`; `drawPanel` places the cursor and draws the new card. Mouse selection is a new pure module `src/mouse-select.ts` (pane hit-test, clamping, text extraction, highlight); `src/app.ts` wires mouse events, Esc, copy, and the `copied` notice. The host mouse mode becomes "at least `drag`" in `src/term/modes.ts`.

**Tech Stack:** TypeScript (Node 24), @xterm/headless, node-pty, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-blockterm-copy-chat-approval-design.md`

## Global Constraints

- Run node/npm as `fnm exec --using=24.19.0 -- npm.cmd …` / `npx.cmd …` from Git Bash. `npm test` builds first; also run `npm run typecheck`.
- No new dependencies. Copy only through the app's existing `copy` (`o.copy ?? copyText(...)`, `src/app.ts:72`).
- Enter approves only through the same guard as `y`: `cardVisibleAt` set and `APPROVAL_QUIET_MS` (400 ms) quiet. Edit/deny Enter keeps its `inputVisibleAt` path.
- When the inner program has mouse tracking on (`mirror.modes.mouseTrackingMode !== 'none'`), shell-area mouse events reach the PTY exactly as today. The agent strip is always blockterm's.
- Existing keys unchanged: ctrl+↑/↓ and `c/o/r/e` block selection, wheel, F1, `#`, terminal-focus `ctrl+l` (clears blocks at an idle prompt), Esc order.
- Card copy (exact): header `wants to type into ` + target; action row `y` chip + ` approve (Enter)`, then `e edit`, `n deny`, `a all`; edit hint `Enter approve · Esc deny`; deny hint `Enter deny · Esc deny` (Esc denies in both modes today, `cardBytes`). Gutter `▌ ` in `38;5;178`; bright text `97`.
- Clear note text: `chat cleared`; busy note (status, not transcript): `Esc to cancel first`. Copy notice: `copied N chars`, 2000 ms.

## Review Focus

1. A drag that starts or ends on the right half of a wide character (`世`, emoji) copies the whole character exactly once (Task 4 test).
2. `hello\r` typed as one burst into the panel, with the card appearing right after: the `\r` must not approve it (Task 3 test).
3. ↑ while the card is in edit/deny mode must not swap history into the edit text (Task 1 test).
4. Long wrapped input with the cursor moved to the start: the drawn cursor stays on a visible input row, never below or above the panel (Task 1 test).
5. A drag released outside the pane (below the panel, past the right edge) clamps to the pane and still copies, and opening or closing the panel mid-drag drops the selection without copying (Task 5 test).

---

### Task 1: Agent input cursor and prompt history

**Files:**
- Modify: `src/focus.ts`, `src/render/panel.ts`
- Test: `tests/focus.test.ts`, `tests/render/panel.test.ts`

**Interfaces:**
- Produces: `PanelUi` gains `cursor?: number` (code-point index into `input`; `undefined` means end of input), `history?: string[]` (submitted prompts, oldest first), `historyAt?: number` (index into `history` while browsing, `undefined` otherwise), `draft?: string`. Every place that sets `input` to a new value without a cursor leaves `cursor` undefined (end).
- Produces: `drawPanel(...).cursor` is at `ui.cursor`'s cell position.

- [ ] **Step 1: Write the failing reducer tests in `tests/focus.test.ts`**

```ts
const keysIn = (ui: PanelUi, ...seq: string[]): PanelUi =>
  seq.reduce((u, s) => reduce(u, bytes(s)).ui, ui);

test('left arrow then typing inserts before the end', () => {
  const ui = keysIn(panel({ input: 'ac' }), '\x1b[D', 'b');
  expect(ui.input).toBe('abc');
  expect(ui.cursor).toBe(2);
});

test('application-cursor arrows and Home/End move the cursor', () => {
  let ui = keysIn(panel({ input: 'abc' }), '\x1bOH');
  expect(ui.cursor).toBe(0);
  ui = keysIn(ui, '\x1bOC', '\x1b[F');
  expect(ui.cursor).toBe(3);
  expect(keysIn(panel({ input: 'abc' }), '\x1b[1~').cursor).toBe(0);
  expect(keysIn(panel({ input: 'abc', cursor: 0 }), '\x1b[4~').cursor).toBe(3);
});

test('backspace deletes before the cursor, by code point', () => {
  const ui = keysIn(panel({ input: 'a世b', cursor: 2 }), '\x7f');
  expect(ui.input).toBe('ab');
  expect(ui.cursor).toBe(1);
});

test('paste inserts at the cursor', () => {
  const ui = reduce(panel({ input: 'ad', cursor: 1 }), { type: 'paste', text: 'bc' }).ui;
  expect(ui.input).toBe('abcd');
  expect(ui.cursor).toBe(3);
});

test('up and down walk submitted prompts and restore the draft', () => {
  let ui = keysIn(panel(), 'one\r');
  ui = { ...ui, mode: 'idle' };
  ui = keysIn(ui, 'two\r');
  ui = { ...ui, mode: 'idle' };
  ui = keysIn(ui, 'dra', '\x1b[A');
  expect(ui.input).toBe('two');
  ui = keysIn(ui, '\x1b[A', '\x1b[A');
  expect(ui.input).toBe('one');
  ui = keysIn(ui, '\x1b[B', '\x1b[B');
  expect(ui.input).toBe('dra');
  expect(ui.historyAt).toBeUndefined();
});

test('the same prompt twice in a row is stored once', () => {
  let ui = keysIn(panel(), 'ls\r');
  ui = keysIn({ ...ui, mode: 'idle' }, 'ls\r');
  expect(ui.history).toEqual(['ls']);
});

test('up during card edit does not recall history', () => {
  const editing = keysIn({ ...withCard(), history: ['old'] }, 'e');
  const ui = keysIn(editing, '\x1b[A');
  expect(ui.input).toBe('rm -rf\r');
});

test('left arrow works in the card edit input', () => {
  const ui = keysIn(withCard(), 'e', '\x1b[D', 'X');
  expect(ui.input.endsWith('X\r')).toBe(true);
});
```

- [ ] **Step 2: Write the failing panel cursor tests in `tests/render/panel.test.ts`**

```ts
test('the cursor sits at ui.cursor, after a wide character', () => {
  const cs = blank();
  const r = drawPanel(cs, FRAME_COLS, RECT, ui({ input: '世ab', cursor: 1 }), [], null);
  const promptWidth = '(agent) ❯ '.length;
  expect(r.cursor).toEqual({ row: INPUT_ROW, col: promptWidth + 2 });
});

test('cursor at the start of a long wrapped input stays on a visible row', () => {
  const cs = blank();
  const r = drawPanel(cs, FRAME_COLS, RECT, ui({ input: 'x'.repeat(500), cursor: 0 }), [], null);
  expect(r.cursor!.row).toBeGreaterThanOrEqual(RECT.row);
  expect(r.cursor!.row).toBeLessThanOrEqual(INPUT_ROW);
});
```

- [ ] **Step 3: Run** `fnm exec --using=24.19.0 -- npx.cmd vitest run tests/focus.test.ts tests/render/panel.test.ts` and expect the new tests to FAIL.

- [ ] **Step 4: Implement in `src/focus.ts`.**
  - In `plainBytes`, before the `data.startsWith(ESC)` drop, match these exact sequences: `\x1b[D` and `\x1bOD` left; `\x1b[C` and `\x1bOC` right; `\x1b[H`, `\x1bOH` and `\x1b[1~` home; `\x1b[F`, `\x1bOF` and `\x1b[4~` end; `\x1b[A` and `\x1bOA` up; `\x1b[B` and `\x1bOB` down.
  - Insert, Backspace and paste work at `cursor ?? length` (code points via `Array.from`).
  - `submit` appends `input` to `history` unless it equals the last entry, then clears `historyAt` and `draft`.
  - The first ↑ saves `draft = input`. ↓ past the newest restores `draft` and clears `historyAt`. A recalled entry puts the cursor at the end.
  - In `cardBytes` edit/deny, handle left/right/home/end the same way; ↑/↓ do nothing. Factor the cursor helpers so both paths share them.

- [ ] **Step 5: Implement in `src/render/panel.ts`.** Compute the cursor from `ui.cursor` over the wrapped input lines (with wide characters). Then clamp: if the cursor's line is above the shown `inputLines` window, slide the window so the cursor's line shows. ponytail: window follows cursor only, no horizontal scroll.

- [ ] **Step 6: Run** the two suites, then `npm test` and `npm run typecheck`. Expect PASS.

- [ ] **Step 7: Commit** `feat: cursor editing and prompt history in the agent input`

### Task 2: Clear agent chat

**Files:**
- Modify: `src/focus.ts`, `src/app.ts`, `src/render/help.ts`, `README.md`
- Test: `tests/focus.test.ts`, `tests/app-agent.test.ts`

**Interfaces:**
- Consumes: `PanelUi.history` from Task 1 (not cleared).
- Produces: `Action` gains `{ type: 'clear-chat' }`.

- [ ] **Step 1: Write the failing tests.**

`tests/focus.test.ts`:
```ts
test('/clear emits clear-chat instead of submitting', () => {
  const r = reduce(panel({ input: ' /clear ' }), bytes('\r'));
  expect(r.actions).toEqual([{ type: 'clear-chat' }]);
  expect(r.ui.input).toBe('');
  expect(r.ui.mode).toBe('idle');
});

test('ctrl+l in the panel emits clear-chat, also when busy', () => {
  expect(reduce(panel(), bytes('\x0c')).actions).toEqual([{ type: 'clear-chat' }]);
  expect(reduce(panel({ mode: 'busy' }), bytes('\x0c')).actions).toEqual([{ type: 'clear-chat' }]);
});
```

`tests/app-agent.test.ts`, following the existing fake-model pattern there:
  - After one exchange, `ctrl+k`, then `/clear\r`, then `hi\r`: the second model call receives only the new user message (no earlier messages), the panel shows `chat cleared`, and the session header value differs from the first call's.
  - While a task is busy, `\x0c` leaves the transcript as it was and the status shows `Esc to cancel first`.

- [ ] **Step 2: Run** them and expect FAIL.

- [ ] **Step 3: Implement.**
  - `focus.ts`: `\r` with `input.trim() === '/clear'` returns `{ input: '', cursor: undefined }` plus the `clear-chat` action, never `submit`, in any mode. `\x0c` returns the `clear-chat` action.
  - `app.ts` `runAction`: if `taskController !== null`, show `Esc to cancel first` through `showSelectionNotice(..., 2000)`. Otherwise: `transcript.length = 0`, `history = []`, `sessionId = null`, `model = null` (so `ensureModel` makes a new id), `agentScroll = 0`, push `{ who: 'note', text: 'chat cleared' }`, then `requestRender()`.
  - Confirm "allow for this task" (`allowRest`) state doesn't outlive a task; if it lives in `app.ts` outside the task, reset it in clear too.
  - Help line: `ctrl+l        clear agent chat (agent line)`. README agent section: one sentence on `/clear` and `ctrl+l`.

- [ ] **Step 4: Run** the suites, `npm test`, `npm run typecheck`. Expect PASS.

- [ ] **Step 5: Commit** `feat: clear the agent chat with /clear or ctrl+l`

### Task 3: Gutter-bar approval card and Enter = approve

**Files:**
- Modify: `src/render/panel.ts`, `src/focus.ts`, `src/app.ts` (`blocksApprove`), `src/render/help.ts`, `README.md`
- Test: `tests/render/panel.test.ts`, `tests/focus.test.ts`, `tests/app-agent.test.ts`

**Interfaces:**
- Consumes: `CardView` unchanged. `drawPanel` reads `ui.card?.editing` / `ui.card?.denying` (already on `PanelView` via `PanelUi`) for the hint row.
- Produces: same `PanelDrawResult`; `cardTruncated` means "doesn't fit even without the blank rows".

- [ ] **Step 1: Write the failing panel tests** (RECT is 40 columns and 10 rows, input on row 11):

```ts
const lsCard = { target: 'pwsh', tokens: displayTokens(parseKeys('ls <Enter>').tokens) };

// 40 cols: "▌  y  approve (Enter)   e edit  n deny" is 38 wide, so "a all" wraps to its own row.
test('card rows carry the amber gutter and the full layout', () => {
  const cs = blank();
  drawPanel(cs, FRAME_COLS, RECT, ui(), [], lsCard);
  const rows = [5, 6, 7, 8, 9, 10].map(r => rowText(cs, r).trimEnd());
  expect(rows).toEqual([
    '▌ wants to type into pwsh',
    '▌',
    '▌   ls·  ⏎ Enter',
    '▌',
    '▌  y  approve (Enter)   e edit  n deny',
    '▌ a all',
  ]);
  for (const r of [5, 6, 7, 8, 9, 10]) expect(cellAt(cs, r, 0).sgr).toBe('38;5;178');
  expect(cellAt(cs, 7, 4).sgr).toBe('97');
  expect(cellAt(cs, 7, 6).sgr).toBe('2'); // the dim ·
  expect(cellAt(cs, 7, 9).sgr.endsWith(';7')).toBe(true); // chip
});

test('blank rows drop first when space is tight', () => {
  const cs = blank();
  const small = { ...RECT, row: 7, rows: 5 };
  const r = drawPanel(cs, FRAME_COLS, small, ui(), [], lsCard);
  expect(r.cardTruncated).toBe(false);
  expect(rowText(cs, 7).trimEnd()).toBe('▌ wants to type into pwsh');
  expect(rowText(cs, 8).trimEnd()).toBe('▌   ls·  ⏎ Enter');
});

test('edit mode shows the edit hint instead of actions', () => {
  const cs = blank();
  const editUi = ui({ card: { keys: 'ls\r', target: 'pwsh', editing: true, denying: false } });
  drawPanel(cs, FRAME_COLS, RECT, editUi, [], lsCard);
  const text = [6, 7, 8, 9, 10].map(r => rowText(cs, r)).join('\n');
  expect(text).toContain('Enter approve · Esc deny');
  expect(text).not.toContain('a all');
});

test('a truncated card keeps the gutter on header and notice', () => {
  const cs = blank();
  const huge = { target: 'pwsh', tokens: displayTokens(parseKeys('x'.repeat(2000)).tokens) };
  const r = drawPanel(cs, FRAME_COLS, RECT, ui(), [], huge);
  expect(r.cardTruncated).toBe(true);
  const rows = Array.from({ length: RECT.rows - 1 }, (_, i) => rowText(cs, RECT.row + i));
  const header = rows.findIndex(t => t.startsWith('▌ wants to type into'));
  expect(header).toBeGreaterThanOrEqual(0);
  expect(rows.slice(header).every(t => t.startsWith('▌ '))).toBe(true);
  expect(rows.slice(header).join(' ')).toContain('too long to show');
});
```

If the exact column for `·`/chip in the first test differs by one because of how separator spacing is applied, fix the assertion to the layout rule (`▌ ` + 2 indent + text, trailing space as `·`, one separator, chip ` ⏎ Enter `), not the other way round.

- [ ] **Step 2: Write the failing key tests.**

`tests/focus.test.ts`:
```ts
test('Enter approves an idle card', () => {
  expect(reduce(withCard(), bytes('\r')).actions).toEqual([
    { type: 'decide', decision: { kind: 'approve', keys: 'rm -rf\r', allowRest: false } },
  ]);
});

test('Enter does nothing on a truncated card', () => {
  expect(reduce(truncatedCard(), bytes('\r')).actions).toEqual([]);
});
```

`tests/app-agent.test.ts`, next to the existing `y`-after-450 ms tests:
  - `\r` sent 10 ms after the card appears is ignored (card still pending). `\r` after `wait(450)` approves (the keys reach the PTY).
  - Review Focus 2: send `hello\r` and then, in the same tick the card appears, `\r` again: the card stays pending.

- [ ] **Step 3: Run** and expect FAIL.

- [ ] **Step 4: Implement.**
  - `focus.ts` `cardBytes`: in the non-edit branch, `ch === '\r' && card.truncated !== true` behaves like `y`.
  - `app.ts` `blocksApprove`: in the non-edit, non-deny branch, treat `\r` as an approve key (`seenAt = cardVisibleAt`). The simplest form adds `'\r'` to `APPROVE_KEYS` and to the `approve` check.
  - `panel.ts`: replace the card builder.
    - Every row starts with the gutter `▌ ` and has a content width of `innerCols - 2`.
    - Header: `wants to type into ` in `1;38;5;178`, target in `97`.
    - Payload indented 2. Text tokens in `97`, with leading and trailing spaces of a text token drawn as `·` in `2`.
    - One separator space only between a text token and a key chip. A chip is ` ${label} ` in `1;38;5;178;7`.
    - Action groups: [`y` chip + ` approve (Enter)` in `97`], [`e` bold amber + ` edit` dim], [`n` … ` deny`], [`a` … ` all`]. Separate them with 3 spaces after the first group and 2 between the others, and wrap only between groups.
    - Edit and deny modes replace the action groups with the hint strings from Global Constraints (dim).
    - Blank gutter rows go after the header and after the payload. Drop them when the full card doesn't fit; truncate (header + `CARD_NOTICE`, both guttered) when the compact card doesn't fit.
    - Delete `CARD_ACTIONS` and the quote wrapping.
  - Help and README: the approve line says `y` or `Enter`.

- [ ] **Step 5: Run** the suites, `npm test`, `npm run typecheck`. Expect PASS.

- [ ] **Step 6: Commit** `feat: gutter-bar approval card, Enter approves`

### Task 4: Pure mouse selection module

**Files:**
- Create: `src/mouse-select.ts`
- Test: `tests/mouse-select.test.ts`

**Interfaces:**
- Consumes: `Layout` (`src/layout.ts`), `Frame`/`Cell` (`src/render/frame.ts`).
- Produces:

```ts
export type Pane = 'shell' | 'agent';
export interface Point { row: number; col: number }
export interface MouseSelection { pane: Pane; anchor: Point; head: Point; moved: boolean }
/** Pane under a host row: shell = rows 0..pty.rows-1, agent = all of panel.rect; else null. */
export function paneAt(layout: Layout, row: number): Pane | null;
export function startSelection(layout: Layout, at: Point): MouseSelection | null;
/** Clamps `at` into the selection's pane (rows) and 0..host.cols-1; sets moved when head changes. */
export function extendSelection(sel: MouseSelection, layout: Layout, at: Point): MouseSelection;
/** Stream selection anchor..head inclusive in reading order; whole middle rows. */
export function selectedText(frame: Frame, sel: MouseSelection): string;
/** Mutates frame.cells in range: sgr '' -> '7', else `${sgr};7`. */
export function highlight(frame: Frame, sel: MouseSelection): void;
```

- [ ] **Step 1: Write the failing tests** with a small hand-built `Frame` (helper `frameOf(lines: string[])` builds cells, giving `世` width 2 followed by a width-0 cell) and `computeLayout({cols:10, rows:6}, panelOpen)`:

```ts
test('paneAt splits shell, agent and the closed-panel footer row', () => {
  const open = computeLayout({ cols: 10, rows: 12 }, true);
  expect(paneAt(open, 0)).toBe('shell');
  expect(paneAt(open, open.pty.rows)).toBe('agent');
  expect(paneAt(open, 11)).toBe('agent');
  const closed = computeLayout({ cols: 10, rows: 6 });
  expect(paneAt(closed, 5)).toBeNull();
});

test('multi-row selection trims trailing spaces and joins rows with \\n', () => {
  const f = frameOf(['hello     ', 'world  x  ']);
  const sel = { pane: 'shell', anchor: { row: 0, col: 2 }, head: { row: 1, col: 6 }, moved: true } as const;
  expect(selectedText(f, sel)).toBe('llo\nworld  x');
});

test('backwards drag gives the same text', () => {
  const f = frameOf(['hello     ', 'world     ']);
  const sel = { pane: 'shell', anchor: { row: 1, col: 4 }, head: { row: 0, col: 1 }, moved: true } as const;
  expect(selectedText(f, sel)).toBe('ello\nworld');
});

test('starting or ending on a wide char half copies it once', () => {
  const f = frameOf(['a世b       ']); // cells: a, 世, '', b
  expect(selectedText(f, { pane: 'shell', anchor: { row: 0, col: 2 }, head: { row: 0, col: 3 }, moved: true })).toBe('世b');
  expect(selectedText(f, { pane: 'shell', anchor: { row: 0, col: 0 }, head: { row: 0, col: 1 }, moved: true })).toBe('a世');
});

test('extendSelection clamps to the starting pane and the right edge', () => {
  const layout = computeLayout({ cols: 10, rows: 12 }, true);
  const sel = startSelection(layout, { row: 1, col: 1 })!;
  const out = extendSelection(sel, layout, { row: 11, col: 40 });
  expect(out.head).toEqual({ row: layout.pty.rows - 1, col: 9 });
  expect(out.moved).toBe(true);
});

test('startSelection on the closed-panel footer row is null', () => {
  expect(startSelection(computeLayout({ cols: 10, rows: 6 }), { row: 5, col: 0 })).toBeNull();
});

test('highlight reverses only the selected cells', () => {
  const f = frameOf(['abcdef    ']);
  f.cells[1]!.sgr = '31';
  highlight(f, { pane: 'shell', anchor: { row: 0, col: 1 }, head: { row: 0, col: 2 }, moved: true });
  expect(f.cells.slice(0, 4).map(c => c.sgr)).toEqual(['', '31;7', '7', '']);
});
```

- [ ] **Step 2: Run** `npx.cmd vitest run tests/mouse-select.test.ts` and expect FAIL.
- [ ] **Step 3: Implement** `src/mouse-select.ts` to these signatures. Before reading or highlighting, widen the start col left past a width-0 cell, and widen the end col right onto the continuation cell of a width-2 lead.
- [ ] **Step 4: Run** and expect PASS. Then `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: pure mouse selection over rendered frames`

### Task 5: Wire mouse selection into the app

**Files:**
- Modify: `src/term/modes.ts`, `src/app.ts`, `src/render/help.ts`, `README.md`
- Test: `tests/term/modes.test.ts`, `tests/input/route.test.ts`, `tests/app.test.ts` (or `tests/app-blocks.test.ts`, whichever has the fake-pty/stdout harness with mouse input)

**Interfaces:**
- Consumes: everything from Task 4; `copy` and `showSelectionNotice` in `app.ts`.
- Produces: `hostModesFrom(mirror: Terminal, t: TrackedModes): HostModes`. The `wantWheel` parameter is removed; `mouse` is `'any'` when the inner mode is `'any'`, otherwise `'drag'`.

- [ ] **Step 1: Write the failing mode and route tests.** Replace the two `hostModesFrom` mouse tests in `tests/term/modes.test.ts`:

```ts
test('hostModesFrom always asks for drag, and any stays any', async () => {
  const term = new XtermTerminal({ allowProposedApi: true });
  const tracked = trackModes(term);
  expect(hostModesFrom(term, tracked.get()).mouse).toBe('drag');
  await write(term, '\x1b[?9h');
  expect(hostModesFrom(term, tracked.get()).mouse).toBe('drag');
  await write(term, '\x1b[?9l\x1b[?1000h');
  expect(hostModesFrom(term, tracked.get()).mouse).toBe('drag');
  await write(term, '\x1b[?1003h');
  expect(hostModesFrom(term, tracked.get()).mouse).toBe('any');
  tracked.dispose();
});
```

`tests/input/route.test.ts`: `encodeMouse` motion with mode `'vt200'` returns `null`, and release with mode `'x10'` returns `null` (pins that the wider host mode doesn't leak to programs).

- [ ] **Step 2: Write the failing app tests** (inject `copy` through the app options; send SGR mouse as `\x1b[<b;x;yM` / `m`, 1-based):
  - Drag in the shell area from (1,1) to (1,5) (`\x1b[<0;1;1M`, `\x1b[<32;5;1M`, `\x1b[<0;5;1m`), over a line that shows `hello`: `copy` is called once with `hello`, and the footer shows `copied 5 chars`.
  - Press and release on the same cell: `copy` is not called.
  - With the inner program in `\x1b[?1000h`, a shell-area drag reaches the PTY as SGR reports and `copy` is not called. A drag in the open agent strip still copies.
  - Review Focus 5: a release reported below the agent strip's last row (or past the right edge) copies the clamped text. `ctrl+k` (layout change) pressed mid-drag clears the selection, and the next release doesn't copy.
  - With a card pending and a highlight showing, `\x1b` clears the highlight and the card is still pending; a second `\x1b` denies it.
  - With F1 help open, a drag doesn't call `copy`.

- [ ] **Step 3: Run** and expect FAIL.

- [ ] **Step 4: Implement.**
  - `modes.ts`: the new `hostModesFrom` rule. Update its comment (host native selection is still Shift+drag), and drop the third argument at the `app.ts` call site.
  - `app.ts`: add `let mouseSel: MouseSelection | null = null` (named apart from the existing block `selected`). In `handleEvent`, after the help branches and before `wheelEvent`:
    - Mouse with a wheel button goes to `wheelEvent` (unchanged).
    - Left press (`(button & 3) === 0`, no motion bit 32, action `press`): if `paneAt` is `'shell'` and the inner tracking isn't `'none'`, fall through to today's path. Otherwise `mouseSel = startSelection(...)`, render, and return.
    - Motion with the left button and `mouseSel !== null`: `extendSelection`, render, return.
    - Release with `mouseSel !== null`: extend; if `moved`, take `selectedText(lastFrame, mouseSel)` and, when it isn't empty, call `copy(text)` and `showSelectionNotice(`copied ${Array.from(text).length} chars`, 2000)`. Keep the highlight. Return.
    - Any other mouse report when blockterm owns that pane: drop, as `wheelEvent` does today.
    - Any `bytes`/`paste`/`page-key`/`agent-key`/`help-key` event while `mouseSel !== null`: clear it and render. If the event is bytes `\x1b`, return (used up). Otherwise carry on.
    - Clear `mouseSel` in `onResize` and in the `layout-changed` action.
    - In `render`, after the panel block and before `drawHelp`, call `highlight(frame, mouseSel)` when it's set and help is closed.
  - Help line: `drag          select text in a pane; release copies`. README: replace the Shift+drag hint with drag-to-copy, and keep Shift+drag as the native fallback.

- [ ] **Step 5: Run** the suites, `npm test`, `npm run typecheck`. Expect PASS.

- [ ] **Step 6: Manual check on Windows Terminal** (`node dist/cli.js`): drag in the shell, then in the agent strip, and paste into Notepad. Drag inside `vim` (`:set mouse=a`): vim gets it. Approve a card with Enter.

- [ ] **Step 7: Commit** `feat: drag to select and copy inside blockterm panes`
