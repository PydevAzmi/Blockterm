# blockterm — design

**Date:** 2026-10-17
**Status:** draft (under review)
**Repo:** https://github.com/pydevazmi/blockterm (MIT, owner `pydevazmi`)
**npm name:** `blockterm` (checked free on npm and PyPI, 2026-10-17)

## 1. Intent

blockterm is an open-source, Warp-like terminal that runs inside the terminal you already have. It
runs your real shell, shows each command and its output as a **block**, and has an **AI agent that
keeps working when you're inside `ssh` or `vim`** (or any full-screen or remote program).

That last point is the reason the product exists. Most AI shell helpers only see the commands you type
into your local shell, so they go blind the moment you `ssh` into a server or open `vim`. blockterm
owns the terminal session itself: it always knows exactly what is on the screen, whatever program
draws it, and it can type into that program for you once you approve.

The user's words: "the main feature that I need this product for is to act like Warp on ssh or vim. It
takes the AI agent into this ssh or vim also." "The app will be similar to Warp."

### Success looks like

- You `ssh prod-box`, press `ctrl+k`, ask "why is nginx failing to start?". The agent reads the remote
  screen, proposes `sudo systemctl status nginx`, and you approve it. It types the command into the
  remote shell, reads the output, and explains the cause. No setup is needed on the remote machine.
- You're in `vim` with a broken YAML file. You press `ctrl+k` and ask "fix the indentation on this
  block". The agent reads the visible buffer and proposes a keystroke sequence (for example
  `:12,18>` then Enter). You approve it and see it happen.
- In your local shell, typing `# find files over 100MB` puts a suggested command into the prompt for
  you to edit. A failed command's block has an "Explain error" action.

## 2. Goals

1. **G1: real terminal.** Run the user's shell in a pseudo-terminal (PTY). vim, ssh, top, less, htop,
   git's pager and Python REPLs all work exactly as they do in a normal terminal, including colours,
   mouse (when the inner program asks for it), resizing and `ctrl+c`.
2. **G2: blocks.** At a local shell prompt, every command and its output is drawn as a block (see the
   mockup in section 6). Each block shows ✔/✘, the exit code and the duration, and has actions to copy
   the command, copy the output, rerun, and explain the error.
3. **G3: an agent that sees everything.** The agent can read what is on screen (and recent scrollback)
   in any mode: local shell, full-screen program, or ssh session.
4. **G4: an agent that can act everywhere, with approval.** The agent can type text and keys (Enter,
   Esc, ctrl+c, arrows…) into whatever program is in front, and run shell commands. Every action that
   writes to the terminal needs the user's approval first.
5. **G5: `#` quick suggest.** At a local shell prompt, a line starting with `#` is sent to the AI
   instead of the shell. The single suggested command is put into the shell prompt, ready to edit, and
   is never run on its own.
6. **G6: bring your own model.** The user chooses the AI SDK provider package (`@ai-sdk/anthropic`,
   `@ai-sdk/openai` or `@ai-sdk/openai-compatible`) and types in the model ID. API keys are read only
   from system environment variables.
7. **G7: works on Windows 11, macOS and Linux.** These shells must work: PowerShell 7 (`pwsh`),
   Windows PowerShell 5.1, Git Bash, bash and zsh.
8. **G8: installable in one line.** `npm i -g blockterm`, then `blockterm`. A README covers all three
   operating systems, and a one-page landing page at `blockterm.mohamedazmi.dev` has copy-paste install
   commands.

## 3. Non-goals (v1)

- A GUI or desktop app (Electron, Tauri, GPU rendering). blockterm is a full-screen TUI inside an
  existing terminal, the same way tmux is.
- Blocks *inside* ssh sessions. A remote shell has no shell integration, so an ssh session is shown as
  one live block (section 5.3). Injecting shell integration into remote hosts ("Warpify") is v2.
- Tabs, split panes, session restore and detaching (tmux already does these).
- Running the agent with no approval at all (auto-run). See anti-goals.
- Agent memory across sessions, a team or cloud sync, or accounts.
- Storing API keys anywhere.
- Telemetry, analytics and update checks.
- Our own line editor. At a shell prompt, editing is done by the user's real shell (readline, PSReadLine,
  zle), so their keybindings and completions keep working.

## 4. Anti-goals (failure even if it "works")

- **The agent types into a terminal without approval.** One wrong keystroke in vim on a production box
  is destructive. Every write needs approval, every time, unless the user explicitly turns on "allow
  for the rest of this task" for that task.
- **blockterm feels worse than the user's normal terminal.** Examples: input lag you can notice, broken
  colours, a broken vim or ssh, mangled Unicode, `ctrl+c` not reaching the program. If wrapping the
  terminal makes ordinary use worse, nothing else matters.
- **Leaking keys.** API keys must never be written to a config file or a log, or shown on screen.
- **Screen contents sent to the AI without the user knowing.** The agent only reads the screen when
  the user has started an agent request. The panel shows when it has read the screen.

## 5. How it works

### 5.1 Stack (decided)

| Part | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript (ESM) on **Node.js 24 LTS** (`engines: ">=24"`) | 24 "Krypton" is the newest LTS (v24.22.0 on 2026-10-14). The user asked for the latest LTS. |
| AI | `ai` (AI SDK 7.x) + `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible` | The user's choice: these exact packages. |
| PTY | `node-pty` | ConPTY on Windows, forkpty on Unix. VS Code's terminal uses it. |
| Terminal state | `@xterm/headless` (+ `@xterm/addon-serialize` if needed) | Parses everything the PTY prints into a grid of cells we can read (`buffer.active`, `type: 'normal' \| 'alternate'`, `onBufferChange`, `getLine().translateToString()`), plus OSC handlers for shell integration. |
| Distribution | npm package `blockterm`, bin `blockterm` | |

Versions on npm when checked (2026-10-17): `ai` 7.0.143, `@ai-sdk/anthropic` 4.0.82, `@ai-sdk/openai`
4.0.96, `@ai-sdk/openai-compatible` 3.0.71, `node-pty` 1.1.0, `@xterm/headless` 6.0.0,
`@xterm/addon-serialize` 0.14.0.

The repo's current `.gitignore` is GitHub's Python template. Replace it with a Node one.

### 5.2 Architecture: own the terminal, the same way tmux does

```
 keyboard ──► blockterm input router ──► PTY (user's shell) ──► output bytes
                 │   (ctrl+k, #, block keys)                      │
                 ▼                                                ▼
             agent panel                                   xterm headless mirror
                 ▲                                         (grid, scrollback, modes,
                 └──── read_screen / send_keys ─────────────  OSC 133 marks)
                                                                  │
                                         renderer ◄───────────────┘
                                 (blocks view | live view, header, footer, panel)
                                                  │
                                                  ▼
                                          host terminal (stdout)
```

- blockterm switches the host terminal to its alternate screen and raw mode, and draws everything
  itself, as tmux does.
- The PTY is created at the size of the area inside blockterm's chrome (host rows minus the header and
  footer, minus the agent panel when it's docked). It is resized whenever the host terminal is resized
  or the panel opens or closes.
- All PTY output goes into a single `@xterm/headless` Terminal: the **mirror**. The mirror is the one
  source of truth for what's on screen, and both the renderer and the agent read from it.
- The **renderer** draws the screen from the mirror's cells plus blockterm's own chrome, and repaints
  only what changed. This is the riskiest part of v1 (section 9).

### 5.3 Two views, chosen automatically

- **Blocks view.** Used when the mirror is on the *normal* buffer and shell integration marks are
  arriving. The history is drawn as blocks. The block that's running streams its output, and the
  shell's live prompt line sits at the bottom, where the user types into their real shell.
- **Live view.** Used when the mirror is on the *alternate* buffer (vim, less, htop…) or when no shell
  integration marks are arriving (inside `ssh`, `docker exec`, a nested shell or a REPL). The inner
  program's grid is drawn cell for cell inside the chrome, so it looks the same as it would in a normal
  terminal.
  - When the live view started from a command inside a block (for example `ssh prod`), that block's
    header stays visible as a thin bar (`$ ssh prod — live`). When the program exits and the marks come
    back, the session collapses back into a normal block. Its body is the scrollback the session left
    on the normal buffer.

The agent works the same in both views. The view only changes how things are drawn.

### 5.4 Shell integration (local shells only)

When blockterm starts the user's shell, it injects a small init script that prints **OSC 133**
prompt and command marks (A = prompt start, B = command start, C = output start, D;exit = command
done). It also prints **OSC 7** with the current folder, which feeds the header's folder and git
branch.

- Integration scripts ship for bash, zsh, pwsh and Windows PowerShell 5.1. Git Bash uses the bash
  script.
- Each script must first load the user's normal rc or profile, and add the marks without breaking the
  user's prompt (starship, oh-my-posh, p10k).
- With an unknown shell, or when integration fails, blockterm runs with the live view only and says so
  in the footer.

A **Block** is the span between one A mark and the next. It records the command text (B→C), the
output (C→D), the exit code (from D), the duration (blockterm's own clock between C and D), and the
folder (OSC 7).

### 5.5 Agent

Opened with `ctrl+k` from any view. It appears as a panel docked to the right, or at the bottom when the
host terminal is narrow. The user types a request, and the agent runs a loop with `streamText` and the
tools below.

**Tools:**

| Tool | Needs approval | What it does |
|---|---|---|
| `read_screen` | no | Returns the visible grid as text, the cursor position, the view (`blocks`/`live`), the buffer (`normal`/`alternate`), the foreground program name if node-pty can tell, and the PTY size. |
| `read_scrollback(lines)` | no | Returns up to N lines of recent normal-buffer history as text (capped). |
| `read_block(id)` / `list_blocks` | no | Returns block metadata, plus the command and output text. |
| `send_keys(keys)` | **yes** | Types into the PTY. `keys` is literal text plus named keys in a small documented syntax, for example `<Enter> <Esc> <C-c> <Up> <Tab>`. It is parsed into bytes by a pure function that has unit tests. |
| `run_command(command)` | **yes** | Works only in the blocks view at an idle prompt: types the command and presses Enter, so it becomes a normal block. In the live view the agent must use `send_keys`. |
| `wait_for_output(ms)` | no | Waits until the screen has been quiet for a short time or until `ms` has passed (capped), then returns `read_screen`. |

**Approval:** done through AI SDK 7's `toolApproval` setting. `send_keys` and `run_command` return
`'user-approval'`. The panel shows the exact keys or command, with the named keys spelled out. The user
can then:
- approve it,
- edit it, then approve it,
- deny it (with an optional reason sent back to the model),
- or approve it and turn on "allow for the rest of this task". That lasts until the agent's answer
  finishes or the user cancels it.

The agent loop resumes with `tool-approval-response` messages, following the SDK's two-call flow.
`needsApproval` on tool definitions is deprecated in AI SDK 7, so it must not be used.

**System prompt context:** OS, shell, current folder, git branch, view, and the last failed block (if
the request is about an error). The screen is *not* sent up front; the agent calls `read_screen`.

**Cancel:** `Esc` in the panel cancels the current agent turn (an abort signal).

**Focus:** while the panel has focus, keys go to the panel. `ctrl+k` again, or `Esc` when the panel is
idle, moves focus back to the terminal. The panel stays visible with its history until it's closed.

### 5.6 `#` quick suggest (blocks view only)

When the shell is at an idle prompt (after B, with nothing typed yet) and the user's first key is `#`,
blockterm keeps the keys it would otherwise forward and shows its own one-line input in place of the
prompt. On Enter, it makes one non-agent call asking for a single command (with folder, OS and shell as
context). It then types that command into the real shell prompt *without* Enter, so the user can edit
it with their own shell. `Esc` gives up and leaves the prompt untouched. In the live view, `#` is just a
normal key.

### 5.7 Explain error

A block with exit code ≠ 0 shows `[Explain error]`. Choosing it (by mouse click, or with the block
focused and pressing `e`) opens the agent panel with a request that already contains the command, the
exit code and the tail of the output.

### 5.8 Block navigation

Blocks are a list you can move through with the keyboard. `ctrl+↑`/`ctrl+↓` select the previous or next
block, `Enter` jumps back to the prompt, `c` copies the command, `o` copies the output, `r` reruns, and
`e` explains. Copying uses OSC 52, with a fallback to the platform clipboard command. Final key choices
are listed in the F1 help screen, and must not take keys that common shells or vim need.

### 5.9 Model configuration

There is one active **profile**, stored as JSON at `<config dir>/blockterm/config.json`. On Windows the
config dir is `%APPDATA%`; elsewhere it is `$XDG_CONFIG_HOME`, falling back to `~/.config`.

```json
{
  "provider": "@ai-sdk/anthropic",
  "model": "<model id the user typed>",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "baseURL": null,
  "name": null
}
```

- `provider` must be one of the three packages. All three are regular dependencies of blockterm, and a
  fixed map from package name to factory picks one (`createAnthropic`, `createOpenAI`,
  `createOpenAICompatible`). Nothing is installed at runtime.
- `model` is free text, passed through as typed. blockterm doesn't keep a list of models.
- `apiKeyEnv` names the environment variable that holds the key. The defaults are `ANTHROPIC_API_KEY`
  and `OPENAI_API_KEY`. For `openai-compatible` there's no default and the user names one. It may be
  empty for keyless local servers such as Ollama or LM Studio.
- `baseURL` and `name` are required for `@ai-sdk/openai-compatible`, and optional for the others (for
  proxies).
- The key's *value* is never written anywhere. If the variable is missing, the agent panel says which
  variable to set and shows the commands for the user's shell (`setx` / `$env:` / `export`).

`blockterm setup` asks for each field in plain prompts and writes the file. `blockterm doctor` checks the
Node version, the PTY, which shell would launch, whether integration loads, the config file, whether the
key's environment variable exists, and makes one tiny model call. `blockterm --version` and `--help`
work as usual. `blockterm --shell <path>` overrides the shell.

The first time blockterm launches without a config file, the terminal still works. `ctrl+k` and `#` then
show "Run `blockterm setup` to choose a model".

### 5.10 Header and footer

- **Header:** `blockterm`, the current folder (shortened to `~`), the git branch (read from `.git/HEAD`
  of the OSC 7 folder, with no git process spawned), and the model name.
- **Footer:** `F1 help · ctrl+k agent · ctrl+l clear`, plus status (no integration, missing key, agent
  busy).

`ctrl+l` clears the block history (and passes through to the PTY when in the live view).

### 5.11 Default shell

- **Windows:** `pwsh` if it's on PATH, else `powershell.exe`.
- **Elsewhere:** `$SHELL`, else `/bin/sh` with no integration.

`--shell` and a `shell` field in config.json override the default.

## 6. Mockup the user approved

```
┌ blockterm ─────────────── ~/proj (main) ┐
│ ┌ $ git status ──────────── ✔ 0.04s ┐  │
│ │ On branch main                     │  │
│ │ nothing to commit                  │  │
│ └────────────────────────────────────┘  │
│ ┌ $ npm test ────────────── ✘ 1.20s ┐  │
│ │ 1 failing  [Explain error]         │  │
│ └────────────────────────────────────┘  │
├─────────────────────────────────────────┤
│ ❯ # list big files_                     │
└ F1 help · ctrl+k AI · ctrl+l clear ─────┘
```

The bottom input line is the real shell prompt (section 5.3), not a separate input box, except while a
`#` request is being typed.

## 7. Testing

- Tests use `vitest` and type checks use `tsc --noEmit`. Use test-first development, slice by slice.
- **Pure units:**
  - parsing `send_keys` syntax into bytes,
  - turning OSC 133 marks into Block records (fed byte streams through a real `@xterm/headless`),
  - layout maths (PTY size from host size and panel state),
  - config validation and provider selection,
  - the approval state machine.
- **PTY integration:** spawn a real shell through node-pty in CI on Windows, macOS and Linux. Run
  commands, check that blocks, exit codes and the folder are recorded, and check that switching to the
  alternate buffer flips to the live view (using a small fake full-screen program that writes
  `\x1b[?1049h`).
- **Agent:** use the AI SDK test helpers (a mock language model) to script tool calls. Check that
  writes pause for approval, that a denial reaches the model, that "allow for this task" ends with the
  task, and that `Esc` aborts.
- **Renderer:** snapshot tests on the frame it produces for a known mirror state and layout.
- **CI:** GitHub Actions running a matrix of `windows-latest`, `macos-latest` and `ubuntu-latest` on
  Node 24.

## 8. Distribution and landing page

- Published to npm as `blockterm`.
- README covers:
  - installing on Windows, macOS and Linux: Node 24 via fnm, nvm or the official installer, then
    `npm i -g blockterm`,
  - choosing a model and setting the key's environment variable on each OS,
  - a privacy note: what's on screen is sent to the chosen provider when the user asks the agent.
- Landing page: one static HTML file in `site/`. It covers what blockterm is, an ssh/vim agent demo
  (GIF or asciinema), and install commands with copy buttons. It's served from the user's VPS at
  `blockterm.mohamedazmi.dev`.

## 9. Risks and spikes to do first

1. **Renderer quality and speed.** Drawing a full inner terminal from mirror cells (colours,
   wide/emoji characters, the cursor, mouse modes passed through, bracketed paste, focus events) without
   lag. Spike before anything else, and keep it if it feels the same as a normal terminal.
2. **node-pty install on user machines.** It's a native module. Check that `npm i -g blockterm` on a
   clean Windows/macOS/Linux machine with Node 24 doesn't need a compiler (prebuilt binaries). If it
   does, pick a maintained prebuilt fork and record the decision.
3. **Shell integration on PowerShell 5.1 and with custom prompts** (oh-my-posh, starship, p10k).
4. **Windows ConPTY quirks:** resize, the alternate screen, and output ordering.

## 10. Build order (vertical slices)

1. Passthrough: the PTY plus the mirror plus the renderer in live view only. blockterm works as a
   plain terminal wrapper, and vim and ssh work. (This is the spike from risk 1.)
2. Shell integration plus the blocks view, plus the header and footer.
3. Config, `setup` and `doctor`.
4. The agent panel with read-only tools.
5. The write tools with approval. This is the core feature, demoed in ssh and vim.
6. `#` quick suggest and Explain error.
7. Block navigation and actions, and the help screen.
8. Packaging, the README, CI matrix, the landing page, and publishing.

## 11. Left to the builder

- Internal module boundaries and file layout (keep the PTY/mirror, renderer, agent and config modules
  testable without each other).
- The build tool (`tsc` vs `tsup`), the linter, and the formatter.
- Exact colours and box drawing, within the mockup.
- Caps on screen and scrollback sizes sent to the model, and the quiet-time setting for
  `wait_for_output`.
- The agent's system prompt wording.
