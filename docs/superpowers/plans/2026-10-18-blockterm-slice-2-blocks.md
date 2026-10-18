# blockterm Slice 2 — Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At a local bash, zsh or pwsh 7 prompt, every command and its output is drawn as a bordered block with ✔/✘, exit code and duration. The header shows the folder and git branch, you can scroll back through blocks, and the agent can list, read and run blocks.

**Architecture:**
- **Shell integration:** blockterm injects a small integration script into the shell it starts. The script prints OSC 133 marks (A prompt start, B command start, C output start, D;exit done) and OSC 7 (the current folder).
- **Marks to blocks:** a mark parser on the mirror turns those into Block records. Each block owns a snapshot of its output cells, captured at D.
- **Rendering:** in the blocks view (normal buffer and integration active), a new renderer draws a virtual document: finished blocks as boxes, then the live region. The live region is the mirror rows from the current block's or prompt's start to the cursor, drawn 1:1. It shows the bottom of that document, offset by the scroll position.
- **Unchanged:** without marks, and in the full-screen view, the terminal behaves exactly as today.

**Tech Stack:** TypeScript, Node 24, existing `@xterm/headless` (markers via `registerMarker`, OSC handlers), `node-pty`, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-blockterm-design.md`, §5.3 (views, scrolling), §5.4 (shell integration, Block record, injection, A→A redraws), §5.5 (`list_blocks`, `read_block`, `run_command`), §5.9 keys, §5.10 (block actions are slice 7), §5.12 (header/footer), §7.

## Global Constraints

- **View rule unchanged:** `view = alternate ? 'fullscreen' : 'blocks'`. The blocks *renderer* is used only when the view is `blocks` AND integration marks have been seen this session. Otherwise the PTY area is drawn from the mirror exactly as today (slice 1 behavior must not change).
- **Integration shells this slice:** bash (Linux, macOS, and Git Bash/MSYS if it works), zsh, pwsh 7.
  - Windows PowerShell 5.1 has no integration until slice 7: it runs as today.
  - `BLOCKTERM_NO_INTEGRATION=1` turns integration off.
- **Injection:**
  - bash: `--rcfile <tmp>/bashrc`. The wrapper first sources `~/.bashrc`, then *appends* its hooks.
  - zsh: temporary `ZDOTDIR` whose `.zshrc` restores the user's `ZDOTDIR`/`HOME` and sources the user's `.zshrc`, then adds hooks via `add-zsh-hook`.
  - pwsh: `-NoExit -Command ". '<tmp>/blockterm.ps1'"`; the script loads `$PROFILE` first and wraps (doesn't replace) `prompt`.
  - Hooks never replace the user's own hooks (starship, oh-my-posh and p10k keep working).
- **Marks:**
  - OSC 133 `A`, `B`, `C`, `D;<exit>`; OSC 7 `file://<host><path>`.
  - A repeated `A` with no B/C/D between is a prompt redraw, not a new block.
  - `D` with no running block is ignored.
- **Block record:** id (incrementing int), command text (B→C), cwd (latest OSC 7), exitCode, startedAt/endedAt (blockterm's own clock between C and D), and output snapshot lines `{ cells: Cell[]; wrapped: boolean }[]`.
  - The snapshot is captured from the C row to the row before the D prompt.
  - It is capped at 10,000 lines, keeping the first 5,000 and last 5,000 with a `… N lines …` marker.
  - Blocks never reference mirror rows after capture. Mirror scrollback rises to 10,000 lines so captures survive long commands.
- **Blocks rendering:**
  - Each finished block: a top border row `┌ $ <command> ─…─ ✔ 0.81s ┐` (or `✘ <exit> 1.20s` in the fail colour), body rows (snapshot reflowed to the inner width by cell width, joining `wrapped` lines), and a bottom border `└─…─┘`.
  - ✔ uses SGR `32`, ✘ uses SGR `31`.
  - Finished blocks taller than 2× the PTY rows show head and tail around a dim `… N lines …` row.
  - The live region (from the running block's C row, or the latest A row, to the cursor row) is drawn 1:1 below the blocks.
- **Scrolling:**
  - Mouse wheel in the blocks view scrolls 3 rows per notch. The host must report the wheel: request host mouse mode `vt200` while blocks are shown and the inner program hasn't asked for mouse.
  - `shift+PgUp`/`shift+PgDn` scroll a page.
  - Any new output snaps to the bottom unless scrolled up; then the footer shows `↓ new output`.
- **Header:** `blockterm  <folder>  (<branch>)  · <model>`.
  - The folder comes from OSC 7, with `$HOME` shown as `~`.
  - The branch is read from `<folder or ancestor>/.git/HEAD`. A `gitdir:` file is followed; a detached HEAD shows the first 7 characters of the hash. No git process is spawned.
  - The model label is shown when configured.
- **`ctrl+l`:** at an idle prompt it clears the block list (the shell still gets nothing); otherwise it goes to the PTY. Idle means the last mark is `B` and the prompt line is empty: the mirror cells from the B position to the cursor are blank.
- **Agent tools:**
  - `list_blocks()` → `[{ id, command, exitCode, cwd, lines }]` (newest last, at most 50).
  - `read_block({ id, lines? })` → `{ command, exitCode, cwd, output }`, where output is the last `lines` (default 200, max 500) as text.
  - `run_command({ command })` is a WRITE tool: approval exactly like `send_keys`, with the payload shown as the command plus `⏎ Enter`. It is allowed only at an idle prompt; otherwise it returns `{ status: 'error', message: 'not at an idle prompt — use send_keys' }`. The literal command is converted to key syntax by escaping `<` as `<lt>` and appending `<Enter>`.
- **Commands:** use `fnm exec --using=24.19.0 -- npx.cmd/npm.cmd` on the dev box.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A user prompt that already prints OSC 133 itself** (VS Code / WezTerm users' rc files). No duplicate blocks, and nothing breaks. Test in Task 1 with doubled A/B marks.
2. **A command that clears the screen (`clear`, `cls`) or switches to the alt screen mid-block** (`less`, then quit). The block still finishes cleanly, and its snapshot doesn't include the other screen. Test in Task 2.
3. **A huge output** (`seq 1 200000`). The capture cap holds memory flat, and the renderer stays responsive (head/tail render). Test in Task 2 and Task 4.
4. **The user's rc file prints text or fails.** The integration hooks still load, and the user's own output is shown. Test in Task 3 with a temp HOME whose `.bashrc` echoes `hello-rc` and returns non-zero.
5. **Resizing narrower after blocks exist.** Finished blocks reflow by cell width (CJK/emoji kept whole) and never overflow the borders. Test in Task 4.

## File Structure

```
src/blocks/marks.ts        OSC 133/7 parser on the mirror → mark events
src/blocks/store.ts        Block records, snapshot capture, cap, clear, idle-prompt check
src/shellint/scripts.ts    integration script texts (bash, zsh, pwsh) as string constants
src/shellint/inject.ts     shell kind detection + spawn args/env + temp files
src/render/blocks.ts       virtual document → PTY-area cells, scroll, reflow
src/render/header.ts       folder/branch/model header text; git HEAD reader
src/term/session.ts, src/app.ts, src/render/frame.ts, src/agent/tools.ts, src/agent/loop.ts, src/cli.ts   (modified)
tests/...                  one test file per module; tests/integration/blocks.test.ts (real bash/pwsh)
```

---

### Task 1: Mark parser

**Files:** Create `src/blocks/marks.ts`, `tests/blocks/marks.test.ts`

**Interfaces:**
- Produces:

```ts
export type Mark =
  | { kind: 'prompt'; row: number }                       // A — absolute buffer row
  | { kind: 'command'; row: number; col: number }         // B — where typing starts
  | { kind: 'output'; row: number; commandText: string }  // C — commandText read from B pos to the C cursor pos (trimmed)
  | { kind: 'done'; row: number; exitCode: number }       // D
  | { kind: 'cwd'; path: string };                        // OSC 7, URL-decoded path (drive-letter paths kept)
export function watchMarks(mirror: Terminal, onMark: (m: Mark) => void): IDisposable;
```

Rows are absolute (`buffer.active.baseY + cursorY`), taken from an `IMarker` so they stay valid through scroll; expose them via `marker.line` at read time.

- [ ] **Step 1: Write the failing tests** (real headless Terminal, Unicode11):
  - **A full cycle:** writing `'\x1b]133;A\x07$ \x1b]133;B\x07ls -la\r\n\x1b]133;C\x07out\r\n\x1b]133;D;0\x07'` gives the marks in order: `prompt`, `command` (col 2), `output` with `commandText 'ls -la'`, `done` with exitCode 0.
  - **Exit code:** `D;127` gives exitCode 127; a bare `D` gives 0.
  - **OSC 7:**
    - `\x1b]7;file://host/home/u/my%20dir\x07` gives `cwd '/home/u/my dir'`.
    - `file://host/C:/Users/x` gives `'C:/Users/x'`.
    - A non-file URL is ignored.
  - **Redraw:** `A`, `A`, `B` gives only one `prompt` (the duplicate A with nothing between is dropped). Review Focus 1: a doubled `A`+`B` pair from a user prompt gives one prompt and one command.
  - **Stray D:** a `D` before any `C` is dropped.
  - **Fall-through:** the handlers return `false` for unknown 133 sub-commands, so xterm keeps default processing.
- [ ] **Step 2: Run** `… vitest run tests/blocks/marks.test.ts`. Expect: FAIL.
- [ ] **Step 3: Implement `watchMarks`.**
- [ ] **Step 4: Run** the tests. Expect: PASS.
- [ ] **Step 5: Commit:** `feat: OSC 133 and OSC 7 mark parser`

### Task 2: Block store and snapshots

**Files:**
- Create `src/blocks/store.ts`, `tests/blocks/store.test.ts`.
- Modify `src/term/session.ts`: mirror `scrollback: 10000`.

**Interfaces:**
- Consumes: `Mark`, `watchMarks` (Task 1), `Cell` (src/render/frame.ts). Export a `cellFrom(cell: IBufferCell): Cell` helper from frame.ts that reuses its SGR builder.
- Produces:

```ts
export interface SnapLine { cells: Cell[]; wrapped: boolean }
export interface Block { id: number; command: string; cwd: string | null; exitCode: number | null; startedAt: number; endedAt: number | null; lines: SnapLine[]; omitted: number }
export class BlockStore {
  constructor(mirror: Terminal, now?: () => number);
  readonly blocks: readonly Block[];          // finished blocks, oldest first
  get running(): { command: string; startedAt: number; startRow: number } | null;
  get promptRow(): number | null;             // latest A row while no block runs
  get cwd(): string | null;
  get integrated(): boolean;                  // any mark seen
  isIdlePrompt(): boolean;                    // last mark is B and cells from B pos to cursor are blank
  clear(): void;                              // drop finished blocks
  onChange(cb: () => void): IDisposable;
  dispose(): void;
}
```

- [ ] **Step 1: Write the failing tests:**
  - **One block:** after a full cycle with output `a\r\nb`, `blocks[0]` has command `ls -la`, exitCode 0, `lines` texts `['a', 'b']`, and endedAt − startedAt equal to the injected clock difference.
  - **Colour:** a coloured line (`\x1b[31mred`) keeps the sgr `31` in its cells.
  - **Alt screen mid-block** (Review Focus 2): `C`, then `\x1b[?1049h junk \x1b[?1049l`, then `x`, then `D` gives a snapshot without `junk`.
  - **Huge output** (Review Focus 3): 12,000 lines gives `lines.length === 10000` and `omitted === 2000`; the first kept line is `1`, the last kept line is `12000`.
  - **Idle prompt:** `isIdlePrompt()` is true right after `B` with nothing typed, false after typing `x`, and false while running.
  - **clear:** `clear()` empties `blocks` and fires `onChange`.
- [ ] **Step 2: Run** the tests. Expect: FAIL.
- [ ] **Step 3: Implement.**
  - Capture rows from the C marker's line up to the row before the D cursor row, translated to cells. Use `isWrapped` from the next line for the `wrapped` flag of each line.
  - Ignore rows written while the alternate buffer was active: they never reach the normal buffer.
  - When the C marker was disposed by scrollback eviction, capture from row 0 and add the evicted count to `omitted`.
- [ ] **Step 4: Run** the tests. Expect: PASS.
- [ ] **Step 5: Commit:** `feat: block store with output snapshots`

### Task 3: Shell integration scripts and injection

**Files:**
- Create `src/shellint/scripts.ts`, `src/shellint/inject.ts`, `tests/shellint/inject.test.ts`, `tests/integration/shellint.test.ts`.
- Modify `src/cli.ts` / `src/term/session.ts` so `spawnSession` uses the injected args and env.

**Interfaces:**
- Produces:

```ts
export type ShellKind = 'bash' | 'zsh' | 'pwsh' | 'powershell' | 'other';
export function shellKind(file: string): ShellKind;   // by basename without .exe, case-insensitive
export interface Injection { file: string; args: string[]; env: Record<string, string>; cleanup(): void }
export function inject(shell: ShellChoice, env: Record<string, string | undefined>, tmpRoot?: string): Injection; // returns shell unchanged for 'powershell'/'other' or when BLOCKTERM_NO_INTEGRATION=1
```

- [ ] **Step 1: Write the failing tests:**
  - **inject.test:**
    - `shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe')` gives `'pwsh'`; `'/bin/zsh'` gives `'zsh'`; `'bash.exe'` gives `'bash'`; `'powershell.exe'` gives `'powershell'`; `'fish'` gives `'other'`.
    - bash injection args are `['--rcfile', <path>]` and that file exists.
    - zsh sets env `ZDOTDIR` to a temp dir containing `.zshrc`, and records the user's original `ZDOTDIR` in `BLOCKTERM_ORIG_ZDOTDIR`.
    - pwsh args are `['-NoLogo', '-NoExit', '-Command', ". '<path>'"]`.
    - `BLOCKTERM_NO_INTEGRATION=1` returns the input unchanged.
    - `cleanup()` removes the temp files.
    - The script texts contain `133;A`, `133;B`, `133;C`, `133;D` and `]7;file://`.
  - **integration (real shells; `skipIf` the shell isn't on PATH):**
    - **bash:** spawn through `spawnSession` with the injection and `HOME` set to a temp dir whose `.bashrc` runs `echo hello-rc; false` (Review Focus 4). Run `echo hi` then `false`. A `BlockStore` on the session's mirror ends with two blocks: (`echo hi`, exit 0, output `hi`) and (`false`, exit 1). The screen contains `hello-rc`.
    - **zsh** (skip if absent): same with `.zshrc`.
    - **pwsh** (skip if absent; CI windows-latest has it): `Write-Output hi` gives a block with exit 0, and `exit 3` … ends the session with 3.
- [ ] **Step 2: Run** the tests. Expect: FAIL.
- [ ] **Step 3: Implement the three scripts**, following the approach in VS Code's shellIntegration scripts:
  - **bash:** save `$?` first in a function that is the *first* `PROMPT_COMMAND` entry. Emit `D;$?` (only after a command ran) and OSC 7. Re-wrap `PS1` each prompt with `\[\e]133;A\a\]…\[\e]133;B\a\]` if it isn't already wrapped. Set `PS0='\[\e]133;C\a\]'`.
  - **zsh:** `precmd` emits D and OSC 7 and wraps `PS1` with `%{…%}`; `preexec` emits C.
  - **pwsh:** the wrapped `prompt` emits D (from `$?`/`$LASTEXITCODE`), OSC 7, A, then the original prompt text, then B. Use a PSReadLine `Enter` key handler that writes C and calls `AcceptLine()`; fall back to emitting C at the start of the next prompt if PSReadLine is missing.
  - Every hook is guarded so it is installed once.
- [ ] **Step 4: Run** the tests. Expect: PASS where the shell exists (Git Bash locally; bash/zsh/pwsh on CI).
- [ ] **Step 5: Commit:** `feat: shell integration for bash, zsh and pwsh`

### Task 4: Blocks renderer

**Files:**
- Create `src/render/blocks.ts`, `tests/render/blocks.test.ts`.
- Modify `src/render/frame.ts`: when `chrome.blocks` is provided, draw the PTY area from it.

**Interfaces:**
- Consumes: `BlockStore` (Task 2), `Cell`, `Layout`
- Produces:

```ts
export interface BlocksView { store: BlockStore; scroll: number }   // rows scrolled up from the bottom
export function composeBlocks(mirror: Terminal, view: BlocksView, area: Size, now: number): { rows: Cell[][]; cursor: { row: number; col: number } | null; docHeight: number };
// frame.ts: Chrome gains `blocks?: BlocksView`; composeFrame uses composeBlocks for the PTY area when chrome.view === 'blocks' && chrome.blocks?.store.integrated
```

- [ ] **Step 1: Write the failing tests:**
  - **Finished block:** a 40×12 area with one finished block (`ls`, exit 0, 0.81 s, lines `a`, `b`) has rows starting with `┌ $ ls`, a ✔ with sgr `32` and `0.81s` at the right end of the top border, body rows `│a…│` and `│b…│`, then `└──…┘`, then the live prompt row from the mirror.
  - **Failed block:** shows `✘ 1` in sgr `31`.
  - **Cursor:** maps onto the live prompt row.
  - **Reflow** (Review Focus 5): a snapshot captured at width 40 with a 60-character line marked `wrapped` re-wraps to inner width 18 at area width 20. Rows never exceed 20 cells, and a `世` is never split across rows.
  - **Tall block:** a block with 100 lines in a 10-row area renders the head, a `… N lines …` row and the tail.
  - **Scroll:** `scroll: 5` shows rows 5 above the bottom, and the cursor is `null` when scrolled away.
  - **Slice 1 unchanged:** `store.integrated === false` gives composeFrame output identical to before (snapshot compare).
- [ ] **Step 2: Run** the tests. Expect: FAIL.
- [ ] **Step 3: Implement.** Build the document rows top-down (blocks, then the live rows from `store.running?.startRow ?? store.promptRow` to the cursor row). Take the bottom `area.rows` rows after applying `scroll`, clamped to `[0, docHeight − area.rows]`.
- [ ] **Step 4: Run** the tests. Expect: PASS.
- [ ] **Step 5: Commit:** `feat: blocks view renderer`

### Task 5: Header, scrolling, `ctrl+l`, app wiring

**Files:**
- Create `src/render/header.ts`, `tests/render/header.test.ts`.
- Modify `src/app.ts`, `src/input/tokenize.ts` (only if `shift+PgUp`/`PgDn` need recognising), `src/term/modes.ts` (host mouse request in the blocks view), and `tests/app-agent.test.ts` or a new `tests/app-blocks.test.ts`.

**Interfaces:**
- Produces:

```ts
export function gitBranch(folder: string, fs?: { readFile(p: string): string | null }): string | null;
export function headerText(o: { folder: string | null; home: string; branch: string | null; model: string | null }): string;
```

- [ ] **Step 1: Write the failing tests:**
  - **gitBranch** (temp dirs):
    - `.git/HEAD` = `ref: refs/heads/main` gives `main`;
    - a subfolder walks up to find it;
    - a `.git` *file* `gitdir: ../real/.git` is followed;
    - a detached 40-hex HEAD gives its first 7 characters;
    - no repo gives `null`.
  - **headerText:** `{ folder: '/home/u/proj', home: '/home/u', branch: 'main', model: 'claude-haiku-5-5' }` gives `'blockterm  ~/proj (main)  · claude-haiku-5-5'`; a null folder gives just `'blockterm'`.
  - **App, with a FakePty emitting marks:**
    - after a cycle, the screen shows `┌ $ ls`;
    - a wheel-up event (SGR `\x1b[<64;5;5M`) scrolls and the footer shows `↓ new output` after new output arrives;
    - `\x1b[5;2~` (shift+PgUp) scrolls a page;
    - `\x0c` at an idle prompt clears the blocks and is not written to the PTY, but while running it is written;
    - the header shows the OSC 7 folder.
- [ ] **Step 2: Run** the tests. Expect: FAIL.
- [ ] **Step 3: Implement.**
  - Create a `BlockStore` per session and pass the `blocks` view to `composeFrame`.
  - The scroll state lives in the app. Mouse wheel and `shift+PgUp`/`PgDn` are consumed only in the blocks view with integration, and only when the inner program hasn't requested mouse.
  - The header comes from `headerText`, with `gitBranch` recomputed on each OSC 7 change.
- [ ] **Step 4: Run** the full suite. Expect: PASS. Run the slice-1 e2e smoke (`tests/integration/app.test.ts`); it must pass unchanged.
- [ ] **Step 5: Commit:** `feat: blocks in the app — header, scrolling, ctrl+l`

### Task 6: Agent block tools

**Files:** Modify `src/agent/tools.ts`, `src/agent/loop.ts`, `src/agent/prompt.ts`, `src/app.ts`, `tests/agent/loop.test.ts`, `tests/agent/tools.test.ts` (create if absent)

**Interfaces:**
- Consumes: `BlockStore`
- Produces: `ToolContext` gains `blocks: BlockStore | null`. readTools adds `list_blocks` and `read_block`; writeTools adds `run_command` (no `execute`).

- [ ] **Step 1: Write the failing tests:**
  - **list_blocks:** returns the newest 50 as `{ id, command, exitCode, cwd, lines }`.
  - **read_block:** `read_block({ id, lines: 2 })` returns the last 2 output lines as text; an unknown id gives `{ error: 'no block <id>' }`; `lines` is capped at 500.
  - **run_command at an idle prompt:** the approval card payload is `ls -la` + `⏎ Enter`, and the written bytes are `ls -la\r`. A command containing `<` is sent literally (written `a<b\r`).
  - **run_command not idle:** the tool result is `{ status: 'error', message: 'not at an idle prompt — use send_keys' }`, with no approval and nothing written.
  - **No integration** (`blocks: null`): the block tools return `{ error: 'blocks need shell integration' }`.
  - **System prompt:** mentions `run_command` at idle prompts and `send_keys` elsewhere.
- [ ] **Step 2: Run** the tests. Expect: FAIL.
- [ ] **Step 3: Implement.** `run_command` goes through the same approval path as `send_keys`, so every gate from slices 3–5 applies unchanged. Its keys are `command.replaceAll('<', '<lt>') + '<Enter>'`.
- [ ] **Step 4: Run** the full suite. Expect: PASS.
- [ ] **Step 5: Commit:** `feat: list_blocks, read_block and run_command`

### Task 7: End to end, docs and site

**Files:**
- Create `tests/integration/blocks.test.ts`.
- Modify `README.md`, `docs/acceptance.md`, `site/index.html` (Status: blocks move to Works today; hero note), `docs/superpowers/specs/2026-10-17-blockterm-design.md` (§10 note).

- [ ] **Step 1: Write `blocks.test.ts`.** Drive `node dist/cli.js --shell <bash or pwsh>` in node-pty with a headless host, as in tests/integration/app.test.ts, calling `healSpawnHelper()` in `beforeAll`. Skip when neither bash nor pwsh is on PATH.
  1. Run `echo hi`; the screen gets a row containing `┌ $ echo hi` and a `✔`.
  2. Run `false` (bash) or `cmd /c exit 1` (pwsh); the screen shows `✘`.
  3. `exit 0` gives exit code 0.
- [ ] **Step 2: Run** `npm test`. Expect: PASS locally (Git Bash) and in CI.
- [ ] **Step 3: Update the docs.**
  - **README:** blocks, scrolling keys, `BLOCKTERM_NO_INTEGRATION`, supported shells.
  - **acceptance.md:** slice 2 checklist for the owner: starship/oh-my-posh prompt, long output, resize, `clear`.
  - **Site Status:** blocks work in bash, zsh and pwsh 7; Windows PowerShell 5.1 blocks are coming.
- [ ] **Step 4: Commit:** `test: blocks end to end; docs and site`
