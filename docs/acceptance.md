# Acceptance checklist

Manual checks run before each release (spec §7). Every item is compared side by side with the
**bare host terminal** running the same command.

## Slice 1: terminal core

Slice-1 exit gate (spec §9 risk 1): vim, htop, less, ssh and a PSReadLine prompt feel the same as
the bare host terminal on Windows 11 and on one Unix system.

**Slice-1 exit gate: OPEN** — headless checks pass; the following owner items must be run (or
failures agreed to carry into slice 2) before it closes: Windows Terminal + pwsh (vim/nvim, mouse in
vim, `:q`); PowerShell 5.1 real-keyboard feel; Git Bash real-keyboard feel; one Unix host; htop/top;
`git log` pager; ssh to a host then remote vim; `shift+PgUp` delivery; real feel (lag/tearing/cursor
flicker). No failures known so far.

### Verified headlessly — this machine (Windows 11, 2026-10-18)

Method (controller Ruling G): `node dist/cli.js` spawned inside a real `node-pty` ConPTY, its
output fed into an `@xterm/headless` `Terminal` acting as the host, then the host screen read.
Shells: Git Bash (`--shell "C:\Program Files\Git\bin\bash.exe"`) and the default shell
(PowerShell 5.1). "Bare" = the same command in a bare `node-pty` with no blockterm. nvim, htop,
top and pwsh are not installed on this machine.

- [x] **vim through blockterm (Git Bash).** `vim` opens inside the frame; inner borders go blank
  (full-screen view) and vim's UI (`~`, status line) is drawn cell-for-cell inside the chrome.
  `i` inserts text; `Left` moves the cursor (`XM` + Left + `Y` → `XYM`); `Esc` then `:q!` returns
  to the prompt and the view returns to blocks. `DECSCUSR` (`ESC[<n> q`, cursor shape) was seen in
  blockterm's output. Evidence: host screen showed `~` rows, `-- INSERT --`, the inserted text, then
  the shell prompt after `:q!`.
- [x] **less on a long file (500 lines).** Opens full-screen with the file text and the
  `filename` prompt line; `q` exits, the view returns to blocks and the less text is gone.
  Evidence: `L0001` visible while open, absent after `q`.
- [x] **Bracketed paste, multi-line, at a prompt and in vim insert mode.** Paste of
  `echo PASTE_ONE\necho PASTE_TWO` at the Bash prompt ran both lines; paste of `VIM_PASTED` in vim
  insert mode inserted the literal text. Evidence: outputs `PASTE_ONE`/`PASTE_TWO` on the screen;
  `VIM_PASTED` in the vim buffer.
- [x] **Resize the outer PTY during vim and at a prompt.** `pty.resize` 100×30 → 70×20 → 120×35
  (with the host terminal resized too): no crash, and the frame reflows to the new size each time
  (footer row 29 → 19 → 34; right border col 99 → 69 → 119). Both in vim and at the prompt.
- [x] **`ctrl+c` (`\x03`) during `ping -t 127.0.0.1`** (default PowerShell): ping starts, `ctrl+c`
  stops it and the prompt returns (`echo CTRLC_OK` runs).
- [x] **CJK width-2 render.** `cat` of a UTF-8 file containing `UNI:😀:世界:END` showed `世` on a
  width-2 cell with the next cell width 0 (wide-char safe).
- [ ] **Emoji width.** Known issue fixed: the mirror loads `@xterm/addon-unicode11` and uses Unicode 11
  widths (😀 width 2), matching shells and hosts; covered by a headless test. Real-host visual check
  stays **owner to verify**. (Typed emoji input is also corrupted in the headless ConPTY harness even
  without blockterm — see the spike doc.)
- [x] **`cat` of a ~10 MiB file.** 10.01 MiB, 100-byte lines. Time from command start to the shell
  printing the sentinel (prompt effectively back): blockterm **~0.73 s** vs bare node-pty
  **~0.81–0.96 s** (n=2 each, indicative only). A `echo RESP_MARK` sent 200 ms into the output was
  delivered and executed right after the file finished. This measures command completion, indicative
  only — it is **not** a measure of echo latency.
- [x] **Exit code + host restore.** `exit 7` propagated (host process exit code 7), blockterm
  emitted `ESC[?1049l` and the host terminal returned to the normal buffer.

### Owner to run (needs a real terminal, real mouse or hosts the harness cannot drive)

- [ ] **Windows Terminal + pwsh:** vim/nvim insert mode, cursor shape, arrows, mouse click under
  `:set mouse=a`, `:q`. *(pwsh and nvim not installed on this machine.)*
- [ ] **PowerShell 5.1, real keyboard feel** — same checks as the headless list, watched by hand.
- [ ] **Git Bash, real keyboard feel** — same, watched by hand.
- [ ] **One Unix host:** vim, less, top, ssh, paste, emoji/CJK, resize, `cat` a large file.
- [ ] **`htop` (or `top`)** in the full-screen view.
- [ ] **`git log`** through the pager.
- [ ] **`ssh` to a host, then `vim` remotely.**
- [ ] **Mouse in vim** (`:set mouse=a`) with a real mouse.
- [ ] **`shift+PgUp` delivery** on Windows Terminal / iTerm2 / kitty / tmux (spec §5.3).
- [ ] **Real feel: lag, tearing, cursor flicker** compared with the bare terminal.

## Slice 2: blocks

Owner checks for the blocks view. Run these by hand in a real terminal.

- [ ] **starship and oh-my-posh prompts** look right and still produce blocks.
- [ ] **Long output** (e.g. `seq 100000`) shows head/tail elision.
- [ ] **Resizing** reflows blocks.
- [ ] **`clear` and `ctrl+l`** clear the blocks.
- [ ] **vim and less** still go full screen and return to blocks.
- [ ] **Repeated command and leading-space command** (`HISTCONTROL=ignoreboth`) still finish blocks.

## Slice 6: # and explain

Owner checks for `#` suggestions and Explain error. Run these by hand in a real terminal with a real
model.

- [ ] **`#` in bash, zsh and pwsh.** At an empty prompt, type `#`, write a request, press `Enter`, and
  check the suggested command is typed into the prompt without running.
- [ ] **Esc mid-request.** Press `Esc` while the `#` request is pending; nothing is typed and the
  input closes.
- [ ] **A model that can't call tools still works for `#`.** Use a provider or model without tool
  support; `#` still returns one command.
- [ ] **Explain error on a failing `npm test`.** Run `npm test` until it fails, click
  `[Explain error]` on the block, and check the panel shows an explanation.

## Agent (slices 3–5)

Owner checks for the agent panel, the approval card and the write tools. Run these with a real
model, not the headless fake provider.

- [ ] **Real Anthropic key.** `blockterm setup` selects `@ai-sdk/anthropic`, `ANTHROPIC_API_KEY` is
  set, `blockterm doctor` passes, and `ctrl+k` opens the panel with no setup hint.
- [ ] **ssh to a host, ask about a failed service, approve one command.** ssh into a host, stop or
  break a service, ask why it failed, and approve exactly one suggested command. Its output lands in
  the terminal and the card clears.
- [ ] **vim, ask for an edit, approve.** Open a file in vim, ask the agent for a specific edit, and
  approve the keystrokes it wants to send. The edit lands in the buffer.
- [ ] **Deny with a reason.** With a card pending, press `n`, type a reason, press `Enter`. Nothing is
  typed into the shell and the agent sees the reason.
- [ ] **Type a sudo password while a card is pending.** With a card showing, return to the terminal
  with `ctrl+k` and type a password by hand. The keystrokes reach the shell, never the agent, and
  never show in the panel.

