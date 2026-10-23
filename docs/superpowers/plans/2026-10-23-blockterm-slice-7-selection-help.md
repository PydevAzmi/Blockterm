# Slice 7: PS 5.1 Integration, Block Selection, Copying and F1 Help Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows PowerShell 5.1 gets blocks; blocks can be selected from the keyboard with copy / copy output / rerun / explain actions; copying works through OSC 52 plus a native clipboard tool; F1 shows a help overlay.

**Architecture:** PS 5.1 reuses the pwsh script with feature detection. Selection is app state (`selected: number | null`, a block id) that sits at focus-stack level 4 on the terminal path; the renderer highlights the selected block and the app scrolls it into view. Copying is one module (`src/clipboard.ts`). Help is a pure renderer (`src/render/help.ts`) drawn over the frame at focus-stack level 1.

**Tech Stack:** TypeScript (Node 24), @xterm/headless, node-pty, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-blockterm-design.md` — §5.4 (PS 5.1), §5.7 (focus stack, Esc order), §5.9 (keys), §5.10 (block keys, clicking, copying), §5.12 (footer).

## Global Constraints

- Run node/npm as `fnm exec --using=24.19.0 -- npm.cmd …` / `npx.cmd …` from Git Bash. `npm test` builds first. No new dependencies.
- Focus stack (§5.7), top first: F1 help, approval card, `#` input, block selection, panel input, terminal. `Esc` closes only the innermost: help, card, `#`, selection, idle panel. In the terminal with nothing above it, `Esc` goes to the PTY.
- Keys (§5.9): `ctrl+↑` / `ctrl+↓` select previous / next block (xterm sends `\x1b[1;5A` / `\x1b[1;5B`). In selection mode `PgUp`/`PgDn`/`Home`/`End` scroll. F1 is `\x1bOP` or `\x1b[11~` (already tokenized as `help-key`).
- Block keys (§5.10), with a block selected: `c` copies the command, `o` copies the output, `r` reruns (types the command at the idle prompt and presses Enter), `e` explains (the slice-6 Explain path), `Enter` or `Esc` returns to the prompt.
- `ctrl+↑/↓` outside the blocks view, without integration, or with no finished blocks go to the PTY byte-exact.
- `r` is the user's own key, so it needs no approval card, but it only writes when `store.isIdlePrompt()` is true at that moment; otherwise the footer shows `not at an idle prompt`.
- Copying (§5.10): write OSC 52 (`\x1b]52;c;<base64>\x07`) to the host, and also pipe to the first native tool found: `clip` (win32), `pbcopy` (darwin), `wl-copy` (when `WAYLAND_DISPLAY` is set), `xclip -selection clipboard`. Ruling AI below.
- PS 5.1 integration must not break the user's profile or prompt; without PSReadLine it still prints marks from `prompt` (C is then unavailable, so blocks get no output — accepted).
- Approval gates (cardVisibleAt/inputVisibleAt/400 ms quiet/truncation) are untouched. Slice 1/2/6 behavior is identical when none of the new keys are pressed.

Ruling AI: OSC 52 success can't be detected, so blockterm always sends OSC 52 *and* runs the native tool when one exists — cost: a redundant copy on hosts that support both.
Ruling AJ: block action labels are not drawn; while a block is selected the footer status shows `c copy · o output · r rerun · e explain · Esc back`, and clicking a block selects it — cost: no per-action click targets (keyboard covers them).

## Review Focus

1. A command or output containing newlines, ESC or non-ASCII (`世`, emoji) copies byte-exact (base64 of UTF-8 for OSC 52; `clip` gets UTF-16LE so Windows doesn't mangle it) (Task 3 test).
2. `r` on a command whose text contains `\r`/`\n` (multi-line command) must type it so the shell receives the original lines, then one Enter — never run a partial line early: send the command text as one bracketed paste only if the shell enabled 2004, otherwise as-is (Task 2 test).
3. Selection survives new blocks arriving and the 200-block cap dropping the selected one (selection clears, no crash) (Task 2 test).
4. F1 while the approval card is pending: help shows on top; Esc closes help, the card is still pending and its quiet/visibility timers restart (card must be fully visible again before keys count) (Task 4 test).
5. PS 5.1 profile with a custom `prompt` function and `Set-PSReadLineOption` still shows the user's prompt and produces blocks with exit codes (Task 1 test).

---

### Task 1: Windows PowerShell 5.1 integration

**Files:**
- Modify: `src/shellint/inject.ts`, `src/shellint/scripts.ts`, `tests/shellint/inject.test.ts`, `tests/integration/shellint.test.ts`

**Interfaces:**
- Consumes: `PWSH_INTEGRATION`, `inject()`, `shellKind()`
- Produces: `inject()` returns an integrated spawn for kind `'powershell'` on win32 (args `['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', ". '<script>'"]`); `-ExecutionPolicy Bypass` applies only to this process.

- [ ] **Step 1: Write the failing tests:**
  - inject unit: `shellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')` on win32 → integrated spawn with those args and a `.ps1` file written with a UTF-8 BOM (5.1 reads BOM-less files as ANSI).
  - integration (skipIf not win32 or `powershell.exe` missing — it exists on the dev box and CI windows-latest): same three checks as the pwsh test (`echo hi` block exit 0; `cmd /c exit 2` → exitCode 2; `exit 0` ends the session), plus Review Focus 5: a temp profile (`-NoProfile` is NOT used; point `$PROFILE` via a temp `HOME`/`USERPROFILE` with `Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`) defining `function prompt { 'MYPROMPT> ' }` shows `MYPROMPT>` and still records blocks.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Drop `kind === 'powershell'` from the `off` list on win32 only. Write the script with a BOM for both kinds (harmless for pwsh 7). Make the script 5.1-safe by feature detection: no `$PSStyle`, no `??`/`?:`/`&&`, `Get-Module PSReadLine` before overriding `PSConsoleHostReadLine`, and `$LASTEXITCODE`/`$?` handling unchanged.
- [ ] **Step 4: Run** the shellint tests, `npm test`, `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: Windows PowerShell 5.1 shell integration`

### Task 2: Block selection and actions

**Files:**
- Create: `src/selection.ts`, `tests/selection.test.ts`
- Modify: `src/input/tokenize.ts` (only if `\x1b[1;5A/B` need their own event), `src/app.ts`, `src/render/blocks.ts` (highlight + per-block row offsets), `tests/app-blocks.test.ts`, `tests/render/blocks.test.ts`

**Interfaces:**
- Consumes: `BlockStore`, `composeBlocks`, slice-6 `explainBlock` in app.ts, `copyText` (Task 3 — until Task 3 lands, `c`/`o` call an injected `copy(text)` option on the app, default a no-op; Task 3 wires it).
- Produces:

```ts
// src/selection.ts
export type SelectionKey = 'prev' | 'next' | 'copy-command' | 'copy-output' | 'rerun' | 'explain' | 'exit' | 'scroll-page-up' | 'scroll-page-down' | 'scroll-top' | 'scroll-bottom' | null;
export function selectionKey(data: string): SelectionKey;          // maps raw bytes in selection mode
export function moveSelection(ids: readonly number[], current: number | null, dir: 'prev' | 'next'): number | null;
// src/render/blocks.ts: BlocksView gains `selected?: number | null`; composeBlocks result gains `blockRows: { id: number; top: number; height: number }[]` (document rows)
```

- [ ] **Step 1: Write the failing tests:**
  - `selectionKey`: `'\x1b[1;5A'` prev, `'\x1b[1;5B'` next, `c`/`o`/`r`/`e`, `\r` and `\x1b` exit, `\x1b[5~` / `\x1b[6~` / `\x1b[H` / `\x1b[F` (also `\x1b[1~`/`\x1b[4~`) scroll keys, anything else `null`.
  - `moveSelection([1,2,3], null, 'prev')` → 3; `(…, 3, 'prev')` → 2; `(…, 1, 'prev')` → 1; `(…, 3, 'next')` → null (past the newest returns to the prompt); `([], null, 'prev')` → null; a `current` no longer in `ids` → treated as null.
  - Renderer: the selected block's borders use sgr `1;36` (bold cyan); `blockRows` gives each block's top and height.
  - App (FakePty with marks, two finished blocks `ls`, `false`):
    - `\x1b[1;5A` selects the newest block (not written to the PTY), footer status shows `c copy · o output · r rerun · e explain · Esc back`, and the block is scrolled fully into view; again selects the older one.
    - `c` calls copy with `ls`'s command, `o` with its output text (snapText lines joined by `\n`); `e` on the failed block runs Explain; `r` writes `ls\r` to the PTY and exits selection; `r` when the prompt isn't idle writes nothing and shows `not at an idle prompt`.
    - `Esc` and `Enter` exit selection without writing anything; a second `Esc` goes to the PTY.
    - Review Focus 2: `r` on a block whose command is `echo a\necho b` writes exactly `\x1b[200~echo a\necho b\x1b[201~\r` when the inner program enabled 2004 (`\x1b[?2004h`); without 2004 it writes nothing and the footer shows `multi-line rerun needs bracketed paste`. A single-line command writes `<command>\r` in both cases.
    - Review Focus 3: with a block selected, 200 new blocks arrive (cap drops it) → selection clears, footer status back to normal.
    - A left click on a block's rows (blockterm owns the mouse) selects it.
    - `\x1b[1;5A` with no integration, in full screen, or with no blocks is written to the PTY byte-exact.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** App state `selected: number | null`; selection keys are handled on the terminal-focus path below `#` input (if `#` is open, selection can't start). Scroll the selected block into view by setting `scroll` from `blockRows`. Rerun bytes: a single-line command → `${command}\r`; a multi-line one → `\x1b[200~${command}\x1b[201~\r` if `session.mirror.modes.bracketedPasteMode`, else refuse with footer `multi-line rerun needs bracketed paste` (nothing written).
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: block selection with copy, rerun and explain`

### Task 3: Clipboard

**Files:**
- Create: `src/clipboard.ts`, `tests/clipboard.test.ts`
- Modify: `src/app.ts` (wire `copy` to `copyText`, footer flash `copied` for 2 s)

**Interfaces:**
- Produces:

```ts
export function osc52(text: string): string;                       // '\x1b]52;c;' + base64(utf8) + '\x07'
export function nativeTool(platform: NodeJS.Platform, env: Record<string, string | undefined>, has: (cmd: string) => boolean): { cmd: string; args: string[]; encoding: 'utf8' | 'utf16le' } | null;
export function copyText(text: string, o: { writeHost: (s: string) => void; platform?: NodeJS.Platform; env?: Record<string, string | undefined>; spawn?: typeof import('node:child_process').spawn; has?: (cmd: string) => boolean }): void;
```

- [ ] **Step 1: Write the failing tests:** `osc52('世 é\n')` equals `\x1b]52;c;` + `Buffer.from('世 é\n','utf8').toString('base64')` + `\x07`; `nativeTool('win32', …)` → `clip`, `utf16le`; `'darwin'` → `pbcopy`; linux with `WAYLAND_DISPLAY` and `wl-copy` present → `wl-copy`; linux with only `xclip` → `xclip -selection clipboard`; nothing found → null; `copyText` writes OSC 52 to the host and pipes the encoded bytes (UTF-16LE with BOM for clip) to the fake spawn's stdin; a spawn error is swallowed (no throw, no stderr noise).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** `has(cmd)` default: search `PATH` entries (with `PATHEXT` on win32) using `fs.existsSync` — no `which` process. Spawn detached-free with `stdio: ['pipe','ignore','ignore']`, `windowsHide: true`. Wire into app `c`/`o`; footer status shows `copied` for 2 s.
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: copy via OSC 52 and the native clipboard tool`

### Task 4: F1 help overlay, docs and site

**Files:**
- Create: `src/render/help.ts`, `tests/render/help.test.ts`
- Modify: `src/focus.ts` (`help-key` toggles `ui.help`), `src/app.ts` (draw overlay, Esc order), `tests/focus.test.ts`, `tests/app-agent.test.ts` or `tests/app-blocks.test.ts`, `README.md`, `docs/acceptance.md`, `site/index.html`, spec §10 note

**Interfaces:**
- Produces:

```ts
export const HELP_LINES: readonly string[];   // exact copy below
export function drawHelp(cells: Cell[], cols: number, rows: number): void;   // centered box over the frame, clipped to fit
// PanelUi gains `help?: boolean`
```

- [ ] **Step 1: Write the failing tests:**
  - `HELP_LINES` equals exactly:
    ```
    blockterm keys
    ctrl+k        agent panel / switch focus
    #             suggest a command (empty prompt)
    ctrl+↑ ctrl+↓ select a block
      c o r e     copy command, copy output, rerun, explain
    shift+PgUp/Dn scroll blocks
    ctrl+l        clear blocks (idle prompt)
    F1 / Esc      close this help
    ctrl+k replaces readline's kill-line and vim's ctrl+k digraphs.
    ```
  - `drawHelp` at 80×24 draws a bordered box containing every line; at 30×8 nothing overflows the frame.
  - focus: `help-key` sets `help: true` from any focus; while `help`, every event except `help-key`, `Esc` and `agent-key` is dropped (not sent to the PTY or the panel); `Esc` or `help-key` closes it; `agent-key` still toggles focus.
  - App: F1 (`\x1bOP` and `\x1b[11~`) shows the help box; keys typed are not written to the PTY; Esc closes it and the next Esc reaches the PTY. Review Focus 4: with a pending card in a focused panel, F1 → help; Esc closes help; `cardVisibleAt` was reset by the help overlay covering the card, so `y` pressed immediately does not approve (quiet/visible gates).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Draw help last in `render()` (after the panel); while help is open set `cardVisibleAt = null` and `inputVisibleAt = null` so the existing gates require the card to be seen again.
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck`.
- [ ] **Step 5: Docs.** README: block selection keys, copying (OSC 52; tmux needs `set-clipboard on`), F1 help, Windows PowerShell 5.1 now has blocks. acceptance.md: "## Slice 7" owner checklist (PS 5.1 with oh-my-posh, ctrl+↑ selection + c/o/r/e, copy over ssh via OSC 52 in Windows Terminal/iTerm2, F1). Site Status: move "Blocks in Windows PowerShell 5.1" to Works today and add "Block selection, copy and rerun". Spec §10 note: slice 7 shipped with Rulings AH–AJ.
- [ ] **Step 6: Commit** `feat: F1 help; docs and site for slice 7`
