# Blockterm
an open-source terminal named Blockterm. It wraps your real shell — ssh, vim, anything — and keeps it exactly as it is. Press `ctrl+k` to open an agent panel, describe what you want in plain words, and it types into your shell one approved keystroke at a time. Command blocks and `#` suggestions work today.

Website: https://blockterm.mohamedazmi.dev

## Blocks

Each command's output becomes a block with its exit status and how long it took.

Scroll with the mouse wheel or `shift+PgUp`/`shift+PgDn`. At an idle prompt, `ctrl+l` clears the blocks.

Blocks work in bash (including Git Bash on Windows; macOS bash 3.2), zsh, PowerShell 7 (Windows and Linux; not macOS yet) and Windows PowerShell 5.1 (no profile changes and no execution-policy change; the integration script runs as-is). WSL bash runs without blocks for now. Set `BLOCKTERM_NO_INTEGRATION=1` to turn blocks off.

## Selecting, copying and rerunning

Press `ctrl+↑` / `ctrl+↓` to select older / newer blocks, or click a block. With a block selected:

| Key | Action |
| --- | --- |
| `c` | copy the command |
| `o` | copy the output |
| `r` | rerun the command (only at an idle prompt) |
| `e` | explain a failed command in the agent panel |
| `Enter` / `Esc` | back to the prompt |

`PgUp` / `PgDn` / `Home` / `End` scroll the blocks while one is selected.

Copying writes OSC 52 to the terminal and also pipes to the native clipboard tool: `clip` on Windows, `pbcopy` on macOS, `wl-copy` on Wayland, or `xclip -selection clipboard` on X11. Over ssh, OSC 52 sets the clipboard of the terminal you are sitting at when it supports it. In tmux, add `set -g set-clipboard on` to `~/.tmux.conf`.

## Help

Press `F1` for the key list. `F1` or `Esc` closes it.

## `#` suggestions

At an empty prompt, type `#`, write what you want in plain words, and press `Enter`. The suggested command is typed into your prompt for you to edit; it never runs on its own.

A failed command's block ends with `[Explain error]`. Click it, or select the block and press `e`, to open the agent panel with an explanation of what went wrong.

## Install

Install Node 24 with fnm, nvm or the official installer.

```sh
npm i -g blockterm
```

The npm package is available after the first release; until then, build from source below.

Node 24's npm blocks dependency install scripts by default. Windows and macOS use node-pty's
prebuilds; on Linux, allow its build:

```sh
npm i -g --allow-scripts=node-pty blockterm
```

The Linux build needs `python3`, `make` and `g++`.

`blockterm update` runs `npm install -g blockterm@latest` for an npm install, and pulls and
rebuilds a source clone.

## Build from source

```sh
git clone https://github.com/PydevAzmi/Blockterm.git
cd Blockterm
npm install && npm run build && npm link
```

On Linux, building needs `python3`, `make` and `g++`.

## Updating

Update the clone and rebuild with one command:

```sh
blockterm update
```

It runs `git pull --ff-only`, then `npm install` and `npm run build`. An install from `npm i -g blockterm` updates the global package instead (`npm install -g --allow-scripts=node-pty blockterm@latest`). Restart any open blockterm windows afterwards.

## Set up the agent

The agent reads whatever is on your screen — a remote shell, a vim buffer — and types into it, one approved keystroke at a time.

1. Choose the model. `blockterm setup` asks for a provider package (`@ai-sdk/anthropic`, `@ai-sdk/openai` or `@ai-sdk/openai-compatible` for Ollama, LM Studio and friends), the model id, the name of the environment variable that holds your key, and — for openai-compatible — a base URL and a name.

   ```sh
   blockterm setup
   ```

2. Put your key in that environment variable. The key is never written to the config file.

   ```sh
   setx ANTHROPIC_API_KEY "sk-ant-…"                                   # Windows
   echo 'export ANTHROPIC_API_KEY="sk-ant-…"' >> ~/.zshrc              # macOS, Linux
   ```

   Open a new terminal afterwards. Local servers like Ollama or LM Studio need no key.

3. Check your shell, config and key, and make one tiny tool call to confirm the model works:

   ```sh
   blockterm doctor
   ```

4. Ask. Press `ctrl+k` anywhere — even inside ssh or vim — and write in plain words. When the agent wants to type something into your shell, approve it with `y`, edit it with `e`, deny it with `n`, or allow the rest of the task with `a`. It never sends a keystroke you have not approved.

The agent can also run a command at an idle prompt (`run_command`), list recent blocks (`list_blocks`) and read one block's output (`read_block`). `run_command` waits for the same approval as typed keys.

`BLOCKTERM_CONFIG=path` overrides the config file location.

### Config file

`blockterm setup` writes the config. You can also edit it by hand; unknown keys are ignored.

| Field | Meaning |
| --- | --- |
| `provider` | `@ai-sdk/anthropic`, `@ai-sdk/openai` or `@ai-sdk/openai-compatible` |
| `model` | the model id |
| `apiKeyEnv` | name of the environment variable holding the key (`""` for no key) |
| `baseURL` | endpoint for `@ai-sdk/openai-compatible`; a trailing `/chat/completions` is stripped (the SDK adds it) |
| `name` | provider name for `@ai-sdk/openai-compatible` |
| `shell` | shell override for the terminal |
| `headers` | extra request headers, a map of header name to value (default `null`) |
| `sessionHeader` | header name that carries one stable id per conversation (default `null`) |

`baseURL` is normalized on load: if it ends with `/chat/completions` (with or without a trailing slash) the suffix is removed.

`blockterm setup` detects OpenCode Go and sets `sessionHeader` for you. `headers` and `sessionHeader` apply to every provider. OpenCode Go rejects requests without an `x-opencode-session` header, so the agent sends one stable id for each conversation and `blockterm doctor` sends a fresh id.

### OpenCode Go

```json
{
  "provider": "@ai-sdk/openai-compatible",
  "model": "your-model-id",
  "apiKeyEnv": "OPENCODE_API_KEY",
  "baseURL": "https://opencode.ai/inference/go/openai/v1",
  "name": "opencode-go",
  "shell": null,
  "headers": null,
  "sessionHeader": "x-opencode-session"
}
```

### Privacy

When the agent reads your screen, the visible text and up to 500 lines of scrollback are sent to the provider you chose. Nothing is sent until you ask, and typed input only reaches your shell after you approve it.
