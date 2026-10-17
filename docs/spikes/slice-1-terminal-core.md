# Spike: slice 1 terminal core

Date: 2026-10-18 · Windows 11 · Node 24.19.0 · `node-pty` 1.1.0 · `@xterm/headless` 6.0.0

Slice-1 spike for spec §9 risks **1** (renderer quality and speed) and **4** (Windows ConPTY
quirks). Findings below; the runnable checks are in `docs/acceptance.md`.

## How this was run

The agent cannot drive a real interactive terminal, so the checklist was run **headlessly**:
`node dist/cli.js` spawned inside a real `node-pty` ConPTY, its output fed into an
`@xterm/headless` `Terminal` acting as the host, then the host screen read back after each step
(controller Ruling G). Items that need a real terminal, a real mouse, or hosts the harness cannot
reach are marked **owner to verify**.

**Slice-1 exit gate: OPEN** — every headless check passes; the owner items in `docs/acceptance.md`
must be run (or failures agreed to carry into slice 2) before it closes. No failures known so far.

## 1. Does Windows raw-mode stdin deliver SGR mouse, bracketed paste and focus events?

**Owner to verify.** A terminal's stdin bytes cannot be observed from inside the agent's headless
harness.

How: run the script below in a real terminal (Windows Terminal with pwsh / PowerShell 5.1 / Git
Bash, and one Unix host), then click, scroll, paste, focus the window away and back, and press
keys. Read the hex dumps. Click = SGR mouse `ESC[<…M`, wheel = SGR buttons 64/65, paste =
`ESC[200~ … ESC[201~`, focus = `ESC[O` (out) / `ESC[I` (in). Ctrl+C (hex `03`) exits.

The script enables `?1000h` (press/release + wheel), `?1002h` (button-drag), `?1006h` (SGR
encoding), `?2004h` (bracketed paste) and `?1004h` (focus). Without a tracking mode (`?1000h`),
turning on SGR alone reports no mouse, so all three are enabled.

```js
// q1-stdin-probe.mjs — run in a real terminal:  node q1-stdin-probe.mjs
// Then click, wheel, paste, focus away/back, press keys; Ctrl+C exits.
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\x1b[?1006h\x1b[?1000h\x1b[?1002h\x1b[?2004h\x1b[?1004h');
process.stdout.write('probe on: click / wheel / paste / focus / keys; Ctrl+C to stop\r\n');
process.stdin.on('data', b => {
  process.stdout.write('HEX ' + b.toString('hex') + '\r\n');
  if (b.includes(0x03)) {
    process.stdout.write('\x1b[?1004l\x1b[?2004l\x1b[?1002l\x1b[?1000l\x1b[?1006l');
    process.stdin.setRawMode(false);
    process.exit(0);
  }
});
```

If a host does not deliver one of these, record which and what arrives instead; blockterm degrades
per spec §5.7 (raw text when not bracketed, no mouse forwarding when the inner program has not asked
for it, focus forwarded only under mode 1004).

## 2. Which queries needed custom replies?

**Pass.** Only **OSC 10** (foreground) and **OSC 11** (background) need a custom reply (Task 3).
The mirror answers DSR (`ESC[6n`), DA1 (`ESC[c`) and DECRQM (`ESC[?2004$p`) natively.
`src/term/session.ts` registers OSC 10/11 handlers that reply **only** to the query form
(`OSC 1x;?`), never to a colour set. Both are covered by tests (query replies for OSC 10 and OSC 11,
plus a colour-set-is-not-answered case).

## 3. Which hosts deliver `shift+PgUp` (spec §5.3)?

**Owner to verify.** Spec §5.3 names Windows Terminal, iTerm2, kitty and tmux as the hosts to check.
Many keep `shift+PgUp` for their own scrollback. Slice 1 has no host-scroll feature, so this is
data-gathering for slice 2. Not observable headlessly.

## 4. node-pty 1.1.0 prebuilds (slice 8 / risk 2)

**Pass, with a known gap.** Verified from the installed package: `node_modules/node-pty/prebuilds`
holds exactly `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`. There is **no linux
prebuild**; `scripts/prebuild.js` exits 1 for an unknown platform, after which the `install` script
runs `node-gyp rebuild`, which needs `python3`, `make` and a C++ compiler. Fine for CI (the Linux
runner compiles) but it conflicts with goal G8 ("no compiler") for Linux end users. Slice 8 must
choose: per-platform `optionalDependencies` (the esbuild pattern) or a pinned prebuilt fork. The CI
clean-install job (§7) is the gate.

## 5. Lag or tearing vs the bare terminal?

**Headless numbers pass; feel is owner to verify.** `cat` of a 10.01 MiB file (100-byte lines, so it
scrolls constantly): blockterm finished in **~0.73 s** vs bare `node-pty` **~0.81–0.96 s** (n=2 each;
indicative only, not a benchmark), measured from command start to the shell printing a sentinel. An
`echo RESP_MARK` sent 200 ms into the output was delivered and executed immediately after the file
finished, so input stayed responsive and nothing was lost. Frame coalescing was not slower than the
bare PTY here. Tearing, cursor flicker and interactive feel need a real terminal → **owner to
verify**.

## Windows ConPTY notes

- **Default shell** on this machine resolved to `powershell.exe` **5.1** (`5.1.26100`), because
  `pwsh` is not on PATH. Matches the global constraint (`pwsh` if present, else `powershell.exe`).
- **Resize — contradicts the Task 10 finding.** Task 10's fixture reported that Windows ConPTY
  never delivers `'resize'` to a Node child. In this slice-1 harness the opposite was observed:
  resizing the outer `node-pty` (100×30 → 70×20 → 120×35) **did** make blockterm recompute its
  layout and reflow (footer row 29 → 19 → 34; right border col 99 → 69 → 119), reproducibly, at a
  prompt and during vim. That is only reachable if `stdout.on('resize')` fired. Likely reason:
  blockterm reads stdin in raw mode, which keeps libuv's Windows console-size polling active, while
  the Task 10 fixture never read the tty. **Action:** owner to confirm in a real Windows Terminal and
  reconcile with Task 10 (its fixture may need raw-mode stdin like blockterm). vim/less also query
  the console size themselves.
- **Typed emoji through ConPTY.** Writing `😀` (U+1F600) to a `node-pty` in this harness reaches the
  shell as U+FFFD **with or without blockterm** (bare `node-pty` reproduces it); CJK (BMP) is
  unaffected. It is a node-pty/ConPTY input-path issue, not a blockterm bug. Emoji/CJK **output**
  renders correctly (width-2 cells). Owner to check whether real Windows Terminal typing keeps
  emoji.

## Bugs found

None. Every headless checklist item passed. The only early anomaly (less ignoring `q`) was a bug in
the throwaway driver's `settle()` helper, not in `src/`.
