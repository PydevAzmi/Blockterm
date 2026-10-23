# Slice 6: `#` Quick Suggest and Explain Error Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `#` at an empty idle prompt asks the model for one command and types it into the prompt (no Enter); a failed block shows `[Explain error]`, which opens the agent panel with an explanation.

**Architecture:** Both features use one no-tools `generateText` call (spec §5.5) in a new `src/agent/oneshot.ts`. The `#` input is a small pure editor (`src/hash.ts`) that the app puts above the PTY on the terminal-focus path and that the blocks renderer draws in place of the prompt row. Explain error is a label on the bottom border of failed blocks; the renderer returns its hit box and the app handles the click.

**Tech Stack:** TypeScript (Node 24), AI SDK 7 (`ai` `generateText`, `MockLanguageModelV4` in tests), @xterm/headless, vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-blockterm-design.md` — §2 G5, §5.5 (Tool support), §5.7, §5.8, §5.10 (Explain error), §5.11 (no config), §6 mockup.

## Global Constraints

- Run node/npm as `fnm exec --using=24.19.0 -- npm.cmd …` / `npx.cmd …` from Git Bash. `npm test` builds first.
- src uses relative ESM imports with `.js` extensions. No new dependencies.
- `#` and Explain error use a single `generateText` call with **no tools** (§5.5).
- `#` triggers only when: blocks view, integration on, idle prompt, prompt line empty (cells from B to the cursor blank — `BlockStore.isIdlePrompt()`), and the key is a literal `#` (§5.8). Everywhere else `#` goes to the PTY unchanged.
- The suggestion is typed into the shell **without Enter**; it never runs on its own (G5). It is written only if the prompt is still idle and empty at write time.
- Model output written to the PTY is stripped of every C0/C1 control character and DEL (no ESC, CR, LF, TAB survive) before writing.
- Without a config: `#` Enter shows `Run \`blockterm setup\` to choose a model` (§5.11). Missing key: `Set <ENV>`.
- Explain request contains the command, the exit code and the last 200 output lines (§5.10).
- API keys never appear in anything shown or stored: errors go through `redact(text, secrets)` from `src/agent/model.ts`.
- Focus stack (§5.7): card > `#` input > panel input > terminal. `ctrl+k` still toggles focus while `#` input is open; `Esc` closes the `#` input (abandons a pending request); the `#` input lives on the terminal-focus path.
- Approval gates (cardVisibleAt/inputVisibleAt/400 ms quiet/truncation) are not touched.
- Slice 1/2 behavior is identical when no `#` is typed and no block failed.

Ruling AH: block selection (`ctrl+↑`, `e` key) is slice 7, so in slice 6 Explain error is reached by clicking the label (when blockterm owns the mouse) — cost: no keyboard path to Explain until slice 7.

## Review Focus

1. A model reply with a trailing newline, `\r`, ANSI escapes or a code fence must never press Enter or inject escapes — only the cleaned first line reaches the PTY (Task 1 + Task 2 tests).
2. The user types or the shell prints while a `#` request is in flight: the suggestion must not be appended to their text (re-check idle+empty before writing) (Task 2 test).
3. `Esc` while the `#` request is pending aborts it and nothing is written later when the reply arrives (Task 2 test).
4. `#` with a non-empty prompt, a running command, the full-screen view, or no integration is forwarded to the PTY byte-exact (Task 2 test).
5. Clicking `[Explain error]` while an agent task is already running must not start a second task or corrupt history (Task 3 test).

---

### Task 1: One-shot model calls

**Files:**
- Create: `src/agent/oneshot.ts`, `tests/agent/oneshot.test.ts`
- Modify: `src/agent/tools.ts` (export `snapText`)

**Interfaces:**
- Consumes: `LanguageModel` (`ai`), `Block`/`SnapLine` (`src/blocks/store.ts`), `snapText` (tools.ts, now exported)
- Produces:

```ts
export interface OneShotContext { os: NodeJS.Platform; shell: string; folder: string | null }
export function cleanSuggestion(text: string): string;            // '' when nothing usable
export function suggestCommand(o: { model: LanguageModel; ctx: OneShotContext; request: string; signal: AbortSignal }): Promise<string>;
export function explainRequest(block: Block): string;             // user message text
export function explainError(o: { model: LanguageModel; ctx: OneShotContext; block: Block; signal: AbortSignal }): Promise<string>;
```

- [ ] **Step 1: Write the failing tests** (`tests/agent/oneshot.test.ts`):
  - `cleanSuggestion('```bash\nls -la\n```')` → `'ls -la'`; `'ls -la\nrm -rf /'` → `'ls -la'`; `'$ du -sh *'` → `'du -sh *'`; `'  \n\nfind . -size +100M\r\n'` → `'find . -size +100M'`; `'echo \x1b[31mhi\x07'` → `'echo [31mhi'` (controls stripped); `'`ls`'` → `'ls'` (single backticks around the whole line removed); `''` → `''`.
  - `suggestCommand` with a `MockLanguageModelV4` whose `doGenerate` returns `'```sh\ngit status\n```'` resolves `'git status'`; the call had **no tools** and its system prompt contains the OS, shell and folder; the user message is the request text.
  - `explainRequest` for a block `{ command: 'npm test', exitCode: 1, lines: 300 lines 'L1'..'L300' }` contains `Command: npm test`, `Exit code: 1`, `L101` and `L300`, and not `L100`.
  - `explainError` resolves the model's text trimmed; an aborted signal rejects with an abort error.
- [ ] **Step 2: Run** `fnm exec --using=24.19.0 -- npx.cmd vitest run tests/agent/oneshot.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `src/agent/oneshot.ts` with `generateText({ model, system, prompt, abortSignal })` (no `tools`). Exact prompt copy:
  - suggest system: `You turn a request into one shell command. Reply with the command only: no explanation, no code fences.\nOS: ${os}\nShell: ${shell}\nFolder: ${folder ?? 'unknown'}`
  - explain system: `You explain why a shell command failed and how to fix it. Be brief: the cause in one or two sentences, then the fix.\nOS: ${os}\nShell: ${shell}\nFolder: ${folder ?? 'unknown'}`
  - explain user (`explainRequest`): `Command: ${command}\nExit code: ${exitCode ?? 'unknown'}\nLast output lines:\n${last 200 snapText lines joined by \n}`
  - `cleanSuggestion`: drop fence lines (lines starting with ```), take the first non-blank line, strip all chars in `[\x00-\x1f\x7f-\x9f]`, trim, remove one leading `$ ` or `> `, unwrap a line fully wrapped in single backticks.
- [ ] **Step 4: Run** the test file — expect PASS; then `npm test` and `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: one-shot suggest and explain model calls`

### Task 2: `#` quick suggest

**Files:**
- Create: `src/hash.ts`, `tests/hash.test.ts`
- Modify: `src/app.ts`, `src/render/blocks.ts` (draw the `#` line), `src/render/frame.ts` (pass it through `BlocksView`), `tests/app-blocks.test.ts` (or new `tests/app-hash.test.ts`), `tests/render/blocks.test.ts`

**Interfaces:**
- Consumes: `suggestCommand`, `cleanSuggestion` (Task 1); `BlockStore.isIdlePrompt()`; the app's model factory.
- Produces:

```ts
// src/hash.ts
export interface HashState { input: string; status: 'editing' | 'busy' | { error: string } }
export type HashAction = null | { type: 'submit'; request: string } | { type: 'close' };
export function reduceHash(s: HashState, e: InputEvent): { state: HashState; action: HashAction };
// src/render/blocks.ts — BlocksView gains:
//   hash?: { text: string; cursor: boolean } | null   // drawn in place of the live prompt row
```

- [ ] **Step 1: Write the failing tests:**
  - `reduceHash`: printable bytes append; Backspace (`\x7f` and `\b`) deletes one code point; paste appends with CR/LF replaced by spaces; Enter with non-blank input → `submit` with the trimmed request and status `busy`; Enter with blank input → `close`; `Esc` → `close` in every status; any key while `busy` other than Esc is ignored; any key while `{ error }` other than Esc is ignored.
  - Renderer: with `hash: { text: '# list big files', cursor: true }`, the bottom live row shows `# list big files` instead of the prompt row content, and the cursor is at the end of that text.
  - App (FakePty emitting `A`/`B` marks, injected model factory returning a `MockLanguageModelV4`):
    - `#` at an empty idle prompt is **not** written to the PTY and the screen shows `# `; typing `list big files` then Enter calls the model once; the reply `'```\nfind . -size +100M\n```'` is written to the PTY as exactly `find . -size +100M` (no `\r`), and the `#` line disappears.
    - reply `'rm x\r\nreboot'` writes `rm x` only; reply containing `\x1b[2J` writes no ESC.
    - `#` after the user typed `x` at the prompt (FakePty echoes `x`) is written to the PTY as `#`; same while a command is running (after `C`), and with no integration marks at all.
    - `Esc` while busy: the reply resolves later and nothing is written; the prompt is untouched.
    - Prompt no longer idle when the reply arrives (FakePty echoes `y` meanwhile): nothing is written and the `#` line shows `prompt changed — suggestion not typed` until Esc.
    - No config: Enter shows `Run \`blockterm setup\` to choose a model` in the `#` line; nothing written.
    - Model error `boom <the API key value>` shows `boom [redacted]`-style redacted text (whatever `redact` produces), never the key.
    - `ctrl+k` while the `#` input is open moves focus to the panel and keeps the `#` input; `ctrl+k` again returns to it.
- [ ] **Step 2: Run** the new tests — expect FAIL.
- [ ] **Step 3: Implement.**
  - `src/hash.ts` per the interface (pure).
  - `src/app.ts`: state `hash: HashState | null` and `hashController: AbortController | null`. In `route()` (the to-pty path, where ctrl+l is intercepted), a bytes event `'#'` with `session.view === 'blocks' && store.integrated && store.isIdlePrompt()` opens `{ input: '', status: 'editing' }` instead of writing. In `handleEvent`, when `ui.focus === 'terminal'` and `hash !== null`, bytes/paste/page-key events (not `ctrl+k`, which still goes through `reduce`) go to `reduceHash`.
  - Extract the existing model creation in `submit()` into `ensureModel(): LanguageModel | { error: string }` and reuse it for `#` (no-config → the CONFIG_HINT text; missing key → `Set <ENV>` and the existing keyHint notes stay panel-only).
  - On `submit`: call `suggestCommand` with `{ os: process.platform, shell: shell.file, folder: store.cwd }`; on resolve, if aborted do nothing; else if `!store.isIdlePrompt()` set status `{ error: 'prompt changed — suggestion not typed' }`; else if the cleaned text is `''` set `{ error: 'no command suggested' }`; else `session.write(text)` and close. Errors → `{ error: redact(message, secrets) }`. `Esc`/close aborts `hashController`.
  - Pass `hash: { text: '# ' + input (+ '  …' while busy, or '  ' + error), cursor: status === 'editing' }` in the BlocksView; in `composeBlocks`, when `view.hash` is set, replace the last live row (the cursor row) with that text and put the cursor after it (or `null` cursor when `cursor` is false). Clip to the inner width.
  - Clean up `hashController` in the existing cleanup path.
- [ ] **Step 4: Run** the new tests, then `npm test` and `npm run typecheck`. The slice-1 e2e (`tests/integration/app.test.ts`) and `tests/integration/blocks.test.ts` must pass unchanged.
- [ ] **Step 5: Commit** `feat: # quick suggest`

### Task 3: Explain error, docs and site

**Files:**
- Modify: `src/render/blocks.ts` (label + hit boxes), `src/render/frame.ts` (expose hit boxes on `Frame`), `src/app.ts` (click → explain), `tests/render/blocks.test.ts`, `tests/app-blocks.test.ts`, `README.md`, `docs/acceptance.md`, `site/index.html`

**Interfaces:**
- Consumes: `explainError`, `explainRequest` (Task 1); the app's panel/transcript/taskController and `ensureModel()` (Task 2).
- Produces:

```ts
// src/render/blocks.ts — composeBlocks result gains:
//   actions: { row: number; col: number; width: number; blockId: number; kind: 'explain' }[]   // area-relative, visible rows only
// src/render/frame.ts — Frame gains: blockActions?: same items translated to host coordinates
```

- [ ] **Step 1: Write the failing tests:**
  - Renderer: a finished block with exit 1 has a bottom border starting `└ [Explain error] ─` (label text exactly `[Explain error]`), and `actions` contains one entry at that row/col with width 15 and the block's id; an exit-0 block has a plain bottom border and no action; a label scrolled out of view has no action; at an inner width under 17 the label is omitted.
  - App:
    - Left click (SGR `\x1b[<0;col;rowM` then release) on the label while blockterm owns the mouse opens the panel (if closed), pushes a transcript line `Explain error: $ npm test (exit 1)`, calls the model once with **no tools** and a prompt containing the block's command, exit code and output tail, and appends the reply as an agent message; `ui.mode` is `busy` during the call and `idle` after.
    - `Esc` in the panel during the call cancels it (`cancelled` note, mode idle).
    - A click while an agent task is busy does nothing (no second model call, history unchanged).
    - Clicks elsewhere still do nothing; with inner mouse enabled the click goes to the PTY as before.
    - No config → the panel shows the CONFIG_HINT note and no model call.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** The label replaces the start of the bottom border for blocks with `exitCode !== 0` (including `null`); memoized rows stay per block (Task 4 of slice 2's cache). `composeBlocks` reports actions for label rows inside the visible window. The app hit-tests left-button presses in the PTY area only when it owns the mouse (same condition as the wheel). Explain runs through `ensureModel()`, sets `ui.mode = 'busy'`, uses `taskController` so the existing cancel path works, and does not touch `history` (the agent conversation) — it only appends transcript lines.
- [ ] **Step 4: Run** the tests, `npm test`, `npm run typecheck`.
- [ ] **Step 5: Docs.**
  - README: a short "`#` suggestions" section (type `#` at an empty prompt, write what you want, Enter; the command is typed for you to edit, never run) and one line for `[Explain error]` (click it; keyboard access comes with block selection).
  - `docs/acceptance.md`: "## Slice 6: # and explain" owner checklist — `#` in bash/zsh/pwsh, Esc mid-request, a model that can't call tools still works for `#`, Explain error on a failing `npm test`.
  - `site/index.html` Status: move "`#` suggestions and Explain error" to Works today; keep the markup shape.
- [ ] **Step 6: Commit** `feat: Explain error; docs and site for # and explain`
