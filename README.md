# Blockterm
an open-source terminal named Blockterm. It wraps your real shell — ssh, vim, anything — and keeps it exactly as it is. Press `ctrl+k` to open an agent panel, describe what you want in plain words, and it types into your shell one approved keystroke at a time. Command blocks and `#` plain-English suggestions are coming.

Website: https://blockterm.mohamedazmi.dev

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

It runs `git pull --ff-only`, then `npm install` and `npm run build`. An install from `npm i -g blockterm` updates the global package instead. Restart any open blockterm windows afterwards.

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

`BLOCKTERM_CONFIG=path` overrides the config file location.

### Privacy

When you ask the agent something, the text currently on your screen is sent to the model provider you chose. Nothing is sent until you ask, and typed input only reaches your shell after you approve it.
