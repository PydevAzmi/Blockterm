# blockterm Slice 1 — Terminal Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `blockterm` runs the user's shell in a PTY and draws it inside its own chrome, as a plain terminal wrapper. vim, ssh, less and htop work the same as in the bare host terminal.

**Architecture:** node-pty drives the shell. Every output byte is parsed by one `@xterm/headless` Terminal, the "mirror". A renderer composes frames (chrome plus mirror cells), diffs them, and writes ANSI to the host terminal, which blockterm holds in alt-screen raw mode. Host input is tokenized: our keys, mouse, paste and focus events are pulled out, translated to whatever the inner program asked for, and the rest is passed through. Terminal queries are answered by the mirror and written back to the PTY.

**Tech Stack:** TypeScript (ESM, `module: NodeNext`), Node.js 24 LTS, `node-pty@1.1.0`, `@xterm/headless@6.0.0`, `vitest@5`, `typescript@7`, `@types/node@24`.

**Spec:** `docs/superpowers/specs/2026-10-17-blockterm-design.md` (approved r3). This plan is slice 1 of §10. Read §5.2, §5.3 (views), §5.7 (mouse/paste/focus), §5.12 (shell, exit), §9 risks 1 and 4.

**Later slices:** each of slices 2–8 gets its own plan, written after the slice before it lands, because this slice's spike findings (Task 11) feed into them.

## Global Constraints

- `engines.node: ">=24"`, `"type": "module"`, TypeScript `strict: true`.
- Runtime dependencies for this slice: `node-pty` and `@xterm/headless` only. Add no others without asking the owner.
- PTY size is fixed by the layout: `cols = hostCols − 4`, `rows = hostRows − 3`. Resize (debounced 50 ms) only on host resize. Never resize on a view change.
- View rule: `view = mirror.buffer.active.type === 'alternate' ? 'fullscreen' : 'blocks'`.
- Frames: at most 60 Hz (16 ms), each wrapped in `ESC[?2026h` … `ESC[?2026l`, with a stale frame replaced by a newer one.
- Footer text, verbatim: `F1 help · ctrl+k agent · ctrl+l clear`.
- Default shell on Windows: `pwsh` if on PATH, else `powershell.exe`. Elsewhere: `$SHELL`, else `/bin/sh`. `--shell <path>` overrides (one path, no args).
- PTY env adds `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=blockterm`.
- Exit: restore the host terminal (also on a crash), then exit with the shell's exit code.
- `ctrl+k` (`\x0b`) and F1 (`\x1bOP`, `\x1b[11~`) never reach the PTY. In this slice they are tokenized and dropped.
- No telemetry, no network calls.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A tiny host terminal** (for example 10×4, or a window shrunk mid-session). Nothing crashes, and the PTY is at least 1×1. Test in Task 2 and Task 7.
2. **Pasted text containing `\x1b[201~`.** It must not end bracketed paste early, because that would let the rest run as typed keys. Strip the marker. Test in Task 6.
3. **Mouse events outside the PTY area, or beyond column/row 223 in legacy (X10) encoding.** Drop them, never send garbage bytes. Test in Task 6.
4. **A `--shell` that doesn't exist, or a shell that exits immediately.** blockterm prints a clear error after restoring the host and exits non-zero. Test in Task 10.
5. **Burst output** (`cat` of a large file). Renders are coalesced, so input stays responsive. Test in Task 8 (scheduler).

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore (Node), .github/workflows/ci.yml
src/cli.ts              argv parsing + entry (bin)
src/app.ts              wires session, input, renderer, host
src/host.ts             enter/leave sequences, restore-on-exit
src/shell.ts            default shell resolution
src/layout.ts           host size → PTY size + origin
src/term/session.ts     PTY + mirror + query replies + view
src/term/modes.ts       private modes xterm doesn't expose; host mode mirroring
src/input/tokenize.ts   host stdin → InputEvent[]
src/input/route.ts      InputEvent → bytes for the PTY
src/render/frame.ts     Frame model + composeFrame
src/render/diff.ts      Frame diff → ANSI
src/render/schedule.ts  frame coalescing
tests/**/*.test.ts      unit; tests/integration/*.test.ts real node-pty
docs/acceptance.md, docs/spikes/slice-1-terminal-core.md
```

---

### Task 1: Project scaffold + shell resolution

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/shell.ts`, `tests/shell.test.ts`
- Modify: `.gitignore` (replace the Python template with a Node one: `node_modules/`, `dist/`, `coverage/`, `*.log`, `.DS_Store`)

**Interfaces:**
- Produces: `interface ShellChoice { file: string; args: string[] }` and `resolveShell(o: { platform: NodeJS.Platform; env: Record<string, string | undefined>; override?: string; onPath: (exe: string) => boolean }): ShellChoice`, plus `isOnPath(exe: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): boolean`

- [ ] **Step 1: Make sure Node 24 is active.** Run `node --version`; it must print `v24.x`. The owner's machine has v22.11 through fnm, so ask the owner before running `fnm install 24 && fnm use 24`.
- [ ] **Step 2: Scaffold.**
  - `package.json`: name `blockterm`, version `0.0.0`, `"type": "module"`, `engines.node ">=24"`, `bin: { "blockterm": "dist/cli.js" }`, license `MIT`, repository `github:pydevazmi/blockterm`.
  - Scripts: `"build": "tsc"`, `"typecheck": "tsc --noEmit"`, `"test": "vitest run"`.
  - Install: `npm i node-pty@1.1.0 @xterm/headless@6.0.0 && npm i -D typescript@7 vitest@5 @types/node@24`.
  - `tsconfig.json`: `target ES2023`, `module/moduleResolution NodeNext`, `strict`, `rootDir src`, `outDir dist`, `include ["src"]`.
- [ ] **Step 3: Write the failing tests** in `tests/shell.test.ts`:

```ts
const env = { SHELL: '/bin/zsh', PATH: '' };
test('windows prefers pwsh', () =>
  expect(resolveShell({ platform: 'win32', env, onPath: e => e === 'pwsh' })).toEqual({ file: 'pwsh.exe', args: ['-NoLogo'] }));
test('windows falls back to powershell.exe', () =>
  expect(resolveShell({ platform: 'win32', env, onPath: () => false })).toEqual({ file: 'powershell.exe', args: ['-NoLogo'] }));
test('unix uses $SHELL', () =>
  expect(resolveShell({ platform: 'linux', env, onPath: () => false })).toEqual({ file: '/bin/zsh', args: [] }));
test('unix falls back to /bin/sh', () =>
  expect(resolveShell({ platform: 'darwin', env: {}, onPath: () => false })).toEqual({ file: '/bin/sh', args: [] }));
test('override wins, no args', () =>
  expect(resolveShell({ platform: 'win32', env, override: 'C:\\x\\bash.exe', onPath: () => true })).toEqual({ file: 'C:\\x\\bash.exe', args: [] }));
```

- [ ] **Step 4: Run** `npx vitest run tests/shell.test.ts`. Expect: FAIL (module not found).
- [ ] **Step 5: Implement `resolveShell` and `isOnPath` in `src/shell.ts`.** `isOnPath` splits `PATH` on `path.delimiter`. On win32 it tries each `PATHEXT` extension (default `.EXE;.CMD;.BAT`) with `fs.existsSync`.
- [ ] **Step 6: Run** `npx vitest run tests/shell.test.ts && npm run typecheck`. Expect: PASS, no type errors.
- [ ] **Step 7: Commit:** `git add -A && git commit -m "chore: scaffold TypeScript project and shell resolution"`

### Task 2: Layout

**Files:** Create `src/layout.ts`, `tests/layout.test.ts`

**Interfaces:**
- Produces: `interface Size { cols: number; rows: number }`, `interface Layout { host: Size; pty: Size; origin: { row: number; col: number } }`, `computeLayout(host: Size): Layout`

- [ ] **Step 1: Write the failing tests:**

```ts
test('pty is host minus chrome', () =>
  expect(computeLayout({ cols: 120, rows: 40 })).toEqual({ host: { cols: 120, rows: 40 }, pty: { cols: 116, rows: 37 }, origin: { row: 1, col: 2 } }));
test('tiny host clamps to 1x1', () =>
  expect(computeLayout({ cols: 3, rows: 2 }).pty).toEqual({ cols: 1, rows: 1 }));
```

- [ ] **Step 2: Run** `npx vitest run tests/layout.test.ts`. Expect: FAIL.
- [ ] **Step 3: Implement `computeLayout`** with `cols = max(1, hostCols − 4)`, `rows = max(1, hostRows − 3)` and origin `{ row: 1, col: 2 }`. The origin is fixed in this slice; the panel arrives in slice 4.
- [ ] **Step 4: Run** the tests. Expect: PASS.
- [ ] **Step 5: Commit:** `feat: layout maths for PTY size`

### Task 3: Terminal session (PTY + mirror + query replies + view)

**Files:** Create `src/term/session.ts`, `tests/term/session.test.ts`, `tests/helpers/fake-pty.ts`

**Interfaces:**
- Consumes: `Size` (Task 2), `ShellChoice` (Task 1)
- Produces:

```ts
export type View = 'blocks' | 'fullscreen';
export interface PtyLike {
  onData(cb: (d: Buffer | string) => void): IDisposable;
  onExit(cb: (e: { exitCode: number }) => void): IDisposable;
  write(d: string): void; resize(cols: number, rows: number): void; kill(): void;
  readonly process: string;
}
export class TerminalSession {
  constructor(pty: PtyLike, size: Size);
  readonly mirror: Terminal;                 // @xterm/headless, allowProposedApi: true, scrollback: 1000
  get view(): View;
  onParsed(cb: () => void): IDisposable;     // after the mirror finished parsing a chunk (write callback)
  onViewChange(cb: (v: View) => void): IDisposable;
  onExit(cb: (code: number) => void): IDisposable;
  write(data: string): void;                 // → PTY
  resize(size: Size): void;                  // PTY + mirror
  dispose(): void;
}
export function spawnSession(shell: ShellChoice, size: Size, env: Record<string, string>): TerminalSession; // node-pty spawn, encoding: null, cwd: process.cwd()
```

`tests/helpers/fake-pty.ts` exports `class FakePty implements PtyLike`. It has `emit(d: Buffer | string)`, `exit(code)`, `written: string[]` and `resizes: [number, number][]`. Tests await `onParsed` through `new Promise(r => s.onParsed(r))`.

- [ ] **Step 1: Write the failing tests:**
  - `'parses output into the mirror'`: emit `'hello'`, then `mirror.buffer.active.getLine(0)!.translateToString(true) === 'hello'`.
  - `'split UTF-8 code point survives'`: emit `Buffer.from([0xc3])`, then `Buffer.from([0xa9])`; line 0 is `'é'`.
  - `'answers DSR'`: emit `'\x1b[6n'`; `written.join('')` contains `'\x1b[1;1R'`.
  - `'answers DA1'`: emit `'\x1b[c'`; `written.join('')` matches `/\x1b\[\?[\d;]+c/`.
  - `'answers DECRQM'`: emit `'\x1b[?2004$p'`; `written.join('')` matches `/\x1b\[\?2004;\d\$y/`.
  - `'answers OSC 11 background query'`: emit `'\x1b]11;?\x07'`; `written.join('')` matches `/\x1b\]11;rgb:/`.
  - `'alt screen flips view'`: emit `'\x1b[?1049h'`; `view === 'fullscreen'` and `onViewChange` got `'fullscreen'`. Then emit `'\x1b[?1049l'`; view is `'blocks'`.
  - `'resize hits pty and mirror'`: `resize({cols: 50, rows: 20})`; `resizes` is `[[50, 20]]` and `mirror.cols === 50`.
  - `'exit code propagates'`: `exit(3)`; `onExit` receives `3`.
- [ ] **Step 2: Run** `npx vitest run tests/term/session.test.ts`. Expect: FAIL.
- [ ] **Step 3: Implement `TerminalSession`.**
  - PTY data goes to `mirror.write(data, () => emit parsed)`. A Buffer is passed as `Uint8Array` (xterm's own UTF-8 decoder handles split code points).
  - `mirror.onData(d => pty.write(d))`. These are the query replies.
  - `mirror.buffer.onBufferChange` drives the view.
  - If any query test fails because the mirror doesn't answer that query, add the reply as a parser handler in `session.ts`. For OSC 10/11 that means `registerOscHandler`, replying `rgb:ffff/ffff/ffff` for 10 and `rgb:0000/0000/0000` for 11. Mark it with `// ponytail: fixed colours; probe host OSC 10/11 at startup if light themes look wrong`.
  - `spawnSession` calls `pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd, env, encoding: null })`.
- [ ] **Step 4: Run** the tests. Expect: PASS. Record which queries needed a custom handler; Task 11 needs that list.
- [ ] **Step 5: Commit:** `feat: terminal session with headless mirror and query replies`

### Task 4: Tracked modes and host mode mirroring

**Files:** Create `src/term/modes.ts`, `tests/term/modes.test.ts`

**Interfaces:**
- Consumes: `TerminalSession.mirror`
- Produces:

```ts
export interface TrackedModes { mouseSgr: boolean; cursorVisible: boolean; cursorStyle: number } // cursorStyle = DECSCUSR Ps, 0 = default
export function trackModes(mirror: Terminal): { get(): TrackedModes; dispose(): void };
export interface HostModes { appCursor: boolean; appKeypad: boolean; mouse: 'none' | 'x10' | 'vt200' | 'drag' | 'any'; cursorStyle: number }
export function hostModesFrom(mirror: Terminal, t: TrackedModes): HostModes; // reads mirror.modes for the first three
export function hostModeDiff(prev: HostModes | null, next: HostModes): string;
```

- [ ] **Step 1: Write the failing tests** (they write to a real headless Terminal and await the write callback):
  - `'tracks SGR mouse'`: `'\x1b[?1006h'` makes `mouseSgr` true; `'\x1b[?1006l'` makes it false.
  - `'tracks cursor visibility'`: `'\x1b[?25l'` makes `cursorVisible` false.
  - `'tracks cursor style'`: `'\x1b[5 q'` makes `cursorStyle` 5.
  - `'does not swallow modes xterm needs'`: after `'\x1b[?1h'`, `mirror.modes.applicationCursorKeysMode === true`.
  - `hostModeDiff`:
    - `hostModeDiff(a, a) === ''`.
    - From all-defaults to `{appCursor: true}` gives exactly `'\x1b[?1h'`.
    - Mouse `vt200` → `any` gives `'\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1003h'`.
    - `appKeypad` true gives `'\x1b='`, false gives `'\x1b>'`.
    - `cursorStyle` 5 gives `'\x1b[5 q'`.
    - `hostModeDiff(null, defaults)` disables all three mouse modes and sets `'\x1b[?1l'`, `'\x1b>'`, `'\x1b[0 q'`.
- [ ] **Step 2: Run** `npx vitest run tests/term/modes.test.ts`. Expect: FAIL.
- [ ] **Step 3: Implement.**
  - `trackModes` registers `parser.registerCsiHandler({ prefix: '?', final: 'h' | 'l' })` for params 1006 and 25, and `{ intermediates: ' ', final: 'q' }` for DECSCUSR. Every handler returns `false`, so xterm still runs its default handling.
  - `hostModeDiff` maps the mouse modes: x10 → `?1000h` on the host (Task 6 filters out releases), vt200 → `?1000h`, drag → `?1002h`, any → `?1003h`. SGR `?1006h` is always on at the host (Task 9).
  - Add `// ponytail: RIS/DECSTR resets not tracked`.
- [ ] **Step 4: Run** the tests. Expect: PASS.
- [ ] **Step 5: Commit:** `feat: track private modes and mirror them to host`

### Task 5: Input tokenizer

**Files:** Create `src/input/tokenize.ts`, `tests/input/tokenize.test.ts`

**Interfaces:**
- Produces:

```ts
export type MouseAction = 'press' | 'release' | 'motion';
export interface MouseInput { type: 'mouse'; button: number; col: number; row: number; action: MouseAction } // SGR Cb (incl. modifier bits), 0-based host coords
export type InputEvent =
  | { type: 'bytes'; data: string } | MouseInput | { type: 'paste'; text: string }
  | { type: 'focus'; focused: boolean } | { type: 'agent-key' } | { type: 'help-key' };
export class InputTokenizer { push(chunk: string): InputEvent[]; flush(): InputEvent[] } // flush() releases any held partial sequence as bytes
```

Host input arrives SGR-encoded, because the host is in `?1006h`.

- [ ] **Step 1: Write the failing tests:**
  - `'ls\r'` gives `[{type: 'bytes', data: 'ls\r'}]`.
  - `'\x03'` gives `[{type: 'bytes', data: '\x03'}]` (ctrl+c passes through).
  - `'a\x0bb'` gives bytes `'a'`, `agent-key`, bytes `'b'`.
  - `'\x1bOP'` and `'\x1b[11~'` each give `[{type: 'help-key'}]`.
  - `'\x1b[<0;10;5M'` gives `{type: 'mouse', button: 0, col: 9, row: 4, action: 'press'}`. A trailing `m` gives `'release'`. `'\x1b[<32;10;5M'` gives `'motion'`. `'\x1b[<64;1;1M'` (wheel) gives `'press'` with button 64.
  - `'\x1b[200~hi\x0b\x1b[201~'` gives `[{type: 'paste', text: 'hi\x0b'}]` (paste content is literal).
  - Paste split across pushes: `push('\x1b[200~h')` gives `[]`, and `push('i\x1b[201~')` gives one paste `'hi'`.
  - `'\x1b[I'` gives focus `true`; `'\x1b[O'` gives `false`.
  - `push('\x1b[<0;1')` gives `[]`, and `push('0;5M')` gives one mouse event at col 9.
  - `push('\x1b')` gives `[]`, and `flush()` gives `[{type: 'bytes', data: '\x1b'}]`.
  - `'\x1b[A'` gives bytes `'\x1b[A'`.
- [ ] **Step 2: Run** `npx vitest run tests/input/tokenize.test.ts`. Expect: FAIL.
- [ ] **Step 3: Implement `InputTokenizer`.** A position-scanning state machine. It recognises only the forms above. Any complete escape sequence that isn't ours is emitted as bytes, unchanged. A trailing *prefix* of one of our forms is held for the next push.
- [ ] **Step 4: Run** the tests. Expect: PASS.
- [ ] **Step 5: Commit:** `feat: host input tokenizer`

### Task 6: Route input to the PTY

**Files:** Create `src/input/route.ts`, `tests/input/route.test.ts`

**Interfaces:**
- Consumes: `InputEvent`, `MouseInput` (Task 5), `TrackedModes` (Task 4), `Layout` (Task 2), xterm `IModes`
- Produces:

```ts
export function encodeMouse(e: MouseInput, mode: IModes['mouseTrackingMode'], sgr: boolean, layout: Layout): string | null;
export function encodePaste(text: string, bracketed: boolean): string;
export function routeToPty(e: InputEvent, ctx: { modes: IModes; tracked: TrackedModes; layout: Layout }): string | null;
```

- [ ] **Step 1: Write the failing tests.** Use a layout with origin `{row: 1, col: 2}` and a PTY of 116×37.
  - Mouse:
    - SGR, mode `vt200`, a press at host col 12 row 6 gives `'\x1b[<0;11;6M'`; a release gives `'\x1b[<0;11;6m'`.
    - Mode `none` gives `null`.
    - Mode `x10`: a release gives `null`.
    - Mode `vt200`: motion gives `null`. Mode `drag`: motion with button 32 gives a string; motion with button 35 (no button held) gives `null`. Mode `any`: motion with button 35 gives a string.
    - Outside the PTY area (host col 0, or row 0) gives `null`.
    - Legacy (`sgr: false`), press at host col 12 row 6 gives `'\x1b[M' + String.fromCharCode(32, 32 + 11, 32 + 6)`. A legacy release uses button 3. A legacy event at PTY col 223 or more gives `null` (Review Focus 3).
  - Paste:
    - `encodePaste('a', true) === '\x1b[200~a\x1b[201~'`.
    - `encodePaste('a', false) === 'a'`.
    - `encodePaste('x\x1b[201~rm -rf ~\r', true) === '\x1b[200~xrm -rf ~\r\x1b[201~'` (Review Focus 2).
  - Focus: with `sendFocusMode` true, focus gives `'\x1b[I'`; with it false, `null`.
  - `agent-key` and `help-key` give `null`. Bytes pass through unchanged.
- [ ] **Step 2: Run** `npx vitest run tests/input/route.test.ts`. Expect: FAIL.
- [ ] **Step 3: Implement.** Coordinates are `col − origin.col` and `row − origin.row`. Drop anything outside `[0, pty.cols)` × `[0, pty.rows)`. SGR uses those values + 1. Strip every `\x1b[201~` from paste text whether or not the paste is bracketed.
- [ ] **Step 4: Run** the tests. Expect: PASS.
- [ ] **Step 5: Commit:** `feat: translate mouse, paste and focus for the inner program`

### Task 7: Frame composition

**Files:** Create `src/render/frame.ts`, `tests/render/frame.test.ts`

**Interfaces:**
- Consumes: `Layout`, `View`, `TrackedModes`
- Produces:

```ts
export interface Cell { ch: string; width: 0 | 1 | 2; sgr: string } // sgr = SGR params after reset, '' = default, e.g. '1;31', '38;2;1;2;3'
export interface Frame { cols: number; rows: number; cells: Cell[]; cursor: { row: number; col: number; visible: boolean } } // row-major
export interface Chrome { title: string; footer: string; view: View }
export function composeFrame(mirror: Terminal, layout: Layout, chrome: Chrome, cursorVisible: boolean): Frame;
export const FOOTER = 'F1 help · ctrl+k agent · ctrl+l clear';
```

**Chrome** (host coordinates, `C = host.cols`, `R = host.rows`):
- **Row 0:** `┌ ` + title + ` ` + `─` fill + `┐`.
- **Rows 1…R−3:**
  - col 0 and col C−1 are `│`,
  - col 1 and col C−2 are `│` in the blocks view, `' '` in the fullscreen view,
  - cols 2…C−3 hold mirror viewport row `viewportY + (r − 1)`.
- **Row R−2:** `├` + `─` fill + `┤`.
- **Row R−1:** `└ ` + footer + ` ` + `─` fill + `┘`.

The title and footer are truncated to fit, and every row is exactly C cells wide.

- [ ] **Step 1: Write the failing tests.** They use a real headless Terminal at the PTY size from `computeLayout({cols: 40, rows: 10})` (36×7) and await writes.
  - **Text:** write `'hi'`. `cell(1, 2).ch === 'h'` and `cell(1, 3).ch === 'i'`.
  - **Frame corners:** `cell(0, 0) === '┌'`, `cell(0, 39) === '┐'`, `cell(8, 0) === '├'`, `cell(9, 0) === '└'`.
  - **Borders by view:** in the blocks view, `cell(1, 1) === '│'`; in the fullscreen view, `' '`.
  - **Colours:**
    - `'\x1b[31mR'` gives an sgr of `'31'`.
    - `'\x1b[1;38;2;1;2;3mX'` gives `'1;38;2;1;2;3'`.
    - `'\x1b[38;5;200mY'` gives `'38;5;200'`.
    - `'\x1b[44mZ'` gives `'44'`.
  - **Wide characters:** `'世'` puts width 2 at col 2 and width 0 at col 3.
  - **Cursor:** after `'hi'`, `cursor` is `{row: 1, col: 4, visible: true}`. With `cursorVisible = false`, `visible` is `false`.
  - **Footer:** row 9 contains `FOOTER`.
  - **Tiny host:** at host 10×4 (Review Focus 1), every row has exactly 10 cells and nothing throws.
- [ ] **Step 2: Run** `npx vitest run tests/render/frame.test.ts`. Expect: FAIL.
- [ ] **Step 3: Implement `composeFrame`.**
  - **Building the SGR string**, in this order: attributes `1` bold, `2` dim, `3` italic, `4` underline, `5` blink, `7` inverse, `8` invisible, `9` strike, `53` overline. Then fg (palette `<8` → `3n`, `<16` → `9(n−8)`, else `38;5;n`; RGB → `38;2;r;g;b` from `getFgColor()`), then bg (same with `4n`/`10(n−8)`/`48;…`).
  - **Empty cells:** `getChars() === ''` becomes `' '`.
  - **Cursor:** visible only when `cursorVisible`, `viewportY === baseY` and `cursorX < pty.cols`.
- [ ] **Step 4: Run** the tests. Expect: PASS.
- [ ] **Step 5: Commit:** `feat: compose frames from mirror and chrome`

### Task 8: Frame diff and scheduler

**Files:** Create `src/render/diff.ts`, `src/render/schedule.ts`, `tests/render/diff.test.ts`, `tests/render/schedule.test.ts`

**Interfaces:**
- Consumes: `Frame`, `Cell` (Task 7)
- Produces: `renderDiff(prev: Frame | null, next: Frame): string` and `createFrameScheduler(render: () => void, intervalMs: number): { request(): void; dispose(): void }`

- [ ] **Step 1: Write the failing tests:**
  - **Nothing changed:** `renderDiff(f, f) === ''` (same cells, same cursor).
  - **One cell changed:** the output contains `'\x1b[2;3H'` and the new char. Its length is under 60 (proving it doesn't redraw everything).
  - **Full draw:** `renderDiff(null, f)` contains a cursor move to each row 1…rows, and starts with `'\x1b[?2026h\x1b[?25l'`.
  - **Style change:** emits `'\x1b[0;31m'` before the char.
  - **Cursor only:** moving just the cursor emits only the sync/hide prefix and the cursor suffix.
  - **Visible cursor:** the output ends with `'\x1b[2;5H\x1b[?25h\x1b[?2026l'` (cursor at row 1 col 4). A hidden cursor ends with `'\x1b[?2026l'` and has no `?25h`.
  - **Wide characters:** width-0 cells are never written.
  - **Size change:** a frame of a different size is treated as `prev = null`.
  - **Scheduler** (vitest fake timers, Review Focus 5): calling `request()` 1000 times in one tick, then `advanceTimersByTime(16)`, calls `render` once. A `request()` 5 ms after a render waits until 16 ms have passed since that render.
- [ ] **Step 2: Run** `npx vitest run tests/render`. Expect: FAIL.
- [ ] **Step 3: Implement.** Walk the changed cells row by row. Emit a cursor move only when the next changed cell isn't directly after the last one written, and an SGR only when the style changes. End with `\x1b[0m`, then the cursor move and visibility.
- [ ] **Step 4: Run** the tests. Expect: PASS.
- [ ] **Step 5: Commit:** `feat: diff renderer and frame scheduler`

### Task 9: Host, app wiring and CLI

**Files:** Create `src/host.ts`, `src/app.ts`, `src/cli.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
// host.ts
export const ENTER_HOST = '\x1b[?1049h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[H\x1b[2J';
export const LEAVE_HOST = '\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1l\x1b>\x1b[0 q\x1b[0m\x1b[?25h\x1b[?1049l';
export function installRestore(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): () => void; // idempotent; runs on exit, uncaughtException, SIGTERM, SIGHUP
// app.ts
export async function runApp(o: { shell: ShellChoice; stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }): Promise<number>;
// cli.ts
export type Cli = { kind: 'version' } | { kind: 'help' } | { kind: 'run'; shell?: string } | { kind: 'error'; message: string };
export function parseArgs(argv: string[]): Cli;
```

- [ ] **Step 1: Write the failing tests** for `parseArgs`:
  - `[]` gives `{kind: 'run'}`.
  - `['--version']` and `['-v']` give version.
  - `['--help']` and `['-h']` give help.
  - `['--shell', 'C:\\bash.exe']` gives run with that shell.
  - `['--shell']` gives an error with message `'--shell needs a path'`.
  - `['--nope']` gives an error with message `'unknown option: --nope'`.
- [ ] **Step 2: Run** `npx vitest run tests/cli.test.ts`. Expect: FAIL.
- [ ] **Step 3: Implement `parseArgs`.**
- [ ] **Step 4: Implement `runApp`.**
  - **Start-up order:**
    1. `stdin.setRawMode(true)`.
    2. `installRestore`.
    3. Write `ENTER_HOST`.
    4. `computeLayout` from `stdout.columns/rows`.
    5. `spawnSession` with env plus `TERM`, `COLORTERM` and `TERM_PROGRAM`.
    6. `trackModes`.
  - **On each parse** (`onParsed`): `scheduler.request()`.
  - **Render:** compose, diff against the last frame, then write the result plus `hostModeDiff`.
  - **Input:** `stdin` data goes to `tokenizer.push` and then `routeToPty` for each event; anything that isn't null is written to the session. `tokenizer.flush()` runs after 10 ms with no input.
  - **Resize:** on `stdout` `'resize'`, debounce 50 ms, then `session.resize(layout.pty)` and a full redraw (`prev = null`).
  - **Shell exit:** restore, then resolve with the exit code.
- [ ] **Step 5: Implement `cli.ts`.**
  - It starts with `#!/usr/bin/env node`.
  - **version:** prints the `version` from `package.json` (read via `import.meta.url`).
  - **help:** prints usage covering `blockterm [--shell <path>] [--version] [--help]`.
  - **error:** prints the message plus `try: blockterm --help`, and exits 2.
  - **run:** resolves the shell, then `process.exit(await runApp(...))`. If spawning throws, restore first, then print `blockterm: cannot start shell <file>: <message>` and exit 1.
- [ ] **Step 6: Run** `npm test && npm run typecheck && npm run build`. Expect: all PASS, `dist/cli.js` exists.
- [ ] **Step 7: Smoke test:** run `node dist/cli.js` in Windows Terminal. A prompt appears inside the frame, `dir` or `ls` works, and `exit` returns you to the host prompt with the screen restored.
- [ ] **Step 8: Commit:** `feat: wire app, host terminal handling and CLI`

### Task 10: Real PTY integration tests + CI

**Files:** Create `tests/integration/pty.test.ts`, `tests/fixtures/` (small node scripts), `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `spawnSession`, `TerminalSession`

Each fixture is spawned as `spawnSession({ file: process.execPath, args: [fixturePath] }, {cols: 80, rows: 24}, process.env)`, with a 10 s test timeout.

- [ ] **Step 1: Write the tests:**
  - **Output:** `'hello'`, where the fixture prints `hello\n`. The mirror contains `hello` and `onExit` gets `0`.
  - **Exit code:** the fixture runs `process.exit(3)`, and `onExit` gets `3`.
  - **Alt screen:** the fixture writes `\x1b[?1049h`, waits 300 ms, then writes `\x1b[?1049l`. `onViewChange` receives `['fullscreen', 'blocks']` in order.
  - **Resize:** the fixture prints `process.stdout.columns` on `'resize'`. After `session.resize({cols: 60, rows: 20})`, the mirror contains `60` within 2 s.
  - **Query round trip:** the fixture writes `\x1b[6n`, reads raw stdin until `R`, then prints `JSON.stringify(reply)`. The mirror contains `R`.
  - **Missing shell** (Review Focus 4): `spawnSession({file: 'definitely-not-a-shell-xyz', args: []}, …)` either throws, or calls `onExit` with a non-zero code within 2 s.
- [ ] **Step 2: Run** `npx vitest run tests/integration`. Expect: PASS on the owner's Windows machine.
- [ ] **Step 3: Write `ci.yml`.**
  - Runs on push and pull requests.
  - Matrix: `windows-latest`, `macos-latest`, `ubuntu-latest`, on Node `24`.
  - Steps: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
- [ ] **Step 4: Commit:** `test: real PTY integration tests and CI matrix`. Pushing to see CI run needs the owner's go-ahead.

### Task 11: Spike findings and slice-1 exit check

**Files:** Create `docs/spikes/slice-1-terminal-core.md`, `docs/acceptance.md`

- [ ] **Step 1: Write `docs/acceptance.md`, section "Slice 1: terminal core".** It's a manual checklist, run on Windows 11 (Windows Terminal + pwsh, then PowerShell 5.1, then Git Bash) and on one Unix host. Each check is compared side by side with the bare host terminal:
  - `vim` and `nvim`: insert mode, cursor shape, arrows, mouse click if `:set mouse=a`, `:q`.
  - `less` on a long file, `htop` or `top`, and `git log` (the pager).
  - `ssh` to a host, then `vim` remotely.
  - Pasting a multi-line text block at a prompt and in vim insert mode.
  - Resizing the window during `vim` and during prompt editing.
  - `ctrl+c` during `ping`.
  - Emoji and CJK text from `echo`.
  - `cat` of a 10 MB file: input stays responsive and the result looks right.
- [ ] **Step 2: Run the checklist and record findings** in `docs/spikes/slice-1-terminal-core.md`. Cover each of these, as a pass/fail with notes:
  1. Do Windows raw-mode stdin bytes include SGR mouse, bracketed paste and focus events? If not, write down what arrives.
  2. Which queries needed custom replies (from Task 3)?
  3. Which hosts deliver `shift+PgUp` (spec §5.3)?
  4. node-pty 1.1.0 has prebuilt binaries for win32 and darwin only. Linux builds from source, which matters for slice 8 and risk 2.
  5. Any lag or tearing compared with the bare terminal.
- [ ] **Step 3: Exit gate (spec §9 risk 1).** Every checklist item passes on Windows 11 and on one Unix host, or the failure and its follow-up are written down and the owner has agreed to carry it into slice 2.
- [ ] **Step 4: Commit:** `docs: slice 1 acceptance checklist and spike findings`
