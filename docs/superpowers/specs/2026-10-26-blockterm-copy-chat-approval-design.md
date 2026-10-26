# blockterm: mouse copy, agent prompt editing, clear chat, approval card restyle

Date: 2026-10-26. Builds on `2026-10-17-blockterm-design.md` (focus stack §5.7, keys §5.9, copying §5.10).

## Why

Using blockterm day to day hits four rough edges:

1. **Copying text is awkward.** blockterm turns on mouse reporting (`vt200`) to get wheel scrolling, so the host terminal's own drag-select stops working. Shift+drag still works on most hosts, but it ignores blockterm's panes: one selection spans the shell and the agent strip and copies both together.
2. **The agent prompt can't be edited.** The panel input only appends and deletes from the end. Arrow keys are dropped (`plainBytes` ignores anything starting with ESC).
3. **The agent chat can't be cleared.** Transcript and model history only grow.
4. **The approval card is hard to read and slow to answer.** The command blends into the amber text around it, and approving always takes `y`.

Success means: drag anywhere and get exactly the text you see in that pane on the clipboard; edit and recall prompts like a shell line; start a fresh agent chat without restarting; read the card at a glance and approve with Enter.

## Goals

- In-app mouse selection, limited to one pane, copied on release.
- ←/→/Home/End editing and ↑/↓ prompt history in the agent panel input.
- A way to clear the agent chat (transcript plus model history).
- Approval card restyled as "B · Gutter bar" (picked by the user from mockups), with Enter = approve.

## Non-goals

- Keyboard-driven text selection (vi-style copy mode).
- Selecting text scrolled out of view, or auto-scroll while dragging.
- Prompt history kept between sessions.
- Changing what the agent can do or how approval works, apart from adding Enter.

## Anti-goals (failure even if it "works")

- **Enter approving something the user didn't see.** Enter must pass the same guard as `y` (card fully visible via `cardVisibleAt`, 400 ms quiet via `APPROVAL_QUIET_MS`). An Enter meant for the shell or the panel prompt must never approve a card that just appeared. This is the product's core promise ("types only what you approve").
- Breaking mouse for programs that ask for it (vim, htop, tmux in the shell). When `mirror.modes.mouseTrackingMode !== 'none'`, shell-area mouse events go to the PTY exactly as today.
- Copying text with escape sequences or junk in it. Copy what's drawn, as plain text.
- Regressions in existing keys: block selection (ctrl+↑/↓, c/o/r/e), wheel scroll, F1, `#`, Esc order.

## Constraints

- TypeScript, Node 24, @xterm/headless, node-pty, vitest. No new dependencies.
- Run node/npm as `fnm exec --using=24.19.0 -- npm.cmd …` from Git Bash. `npm test` builds first.
- Copy goes through the existing `copyText()` in `src/clipboard.ts` (OSC 52 plus a native tool).
- The panel is a fixed strip below the PTY (`computeLayout`); the last host row is the mode line or footer.

## Design

### 1. Mouse selection

- **Mouse mode.** Always ask the host for at least `drag` (1002): `drag` when the inner program's mode is `none`, `vt200`, or `x10`, and `any` (1003) when the inner program asked for `any`. Motion with a button held then always gets reported, and release always arrives (SGR 1006 is already on in `host.ts`). The shell side is unaffected because `encodeMouse` already drops reports the inner program didn't ask for. When the inner program has tracking on, shell-area events go to the PTY as today. The agent strip is always blockterm's, so it can be selected even while vim is running. *(My call.)*
- **Gesture.** Left press starts a pending selection at (row, col) in the pane under the pointer: shell area = rows `0..pty.rows-1`, agent = all of `layout.panel.rect`, including its last row (the input line, which replaces the mode line while the panel is open). With the panel closed, the last host row (footer or mode line) can't be selected. *(My call.)* Motion with the left button down extends it. Coordinates are clamped to the starting pane's rows. Release with any movement copies. Release on the same cell is a click and does nothing (there's no click handling today and none is added).
- **Keys while a selection shows.** Esc only clears the highlight and is used up. This becomes the top of the Esc order while a selection is visible, so it can never deny a card or cancel a task by accident. Any other key clears the highlight and then does its normal job. *(My call.)*
- **Shape.** A linear (stream) selection like normal terminals: from the start cell to the end cell in reading order, whole middle rows. No block or rectangle mode.
- **Rendering.** Selected cells are drawn reversed (add `7` to the cell SGR) in the composed frame, after panel and card drawing, before help. The selection is cleared by any key press, by a resize, or when that pane's content scrolls or changes under it. *Builder's call:* clear on frame change in that pane, or keep it on frame coordinates; either is fine, as long as nothing mismatched gets copied.
- **Text extraction.** Read from the rendered `Frame.cells` (what the user sees), not the xterm buffer. Per row: join `ch` values, skip width-0 continuation cells, trim trailing spaces. Join rows with `\n`. Treat each screen row as its own line, even if it's a soft wrap (accepted: wrapped long lines copy with line breaks).
- **Feedback.** After copying, the footer status shows `copied N chars` for about 2 s, reusing the selection-notice timer pattern (`selectionNoticeTimer`). An empty selection copies nothing and shows nothing.
- **Wheel** keeps working as today in both panes.
- **Help and the card.** While F1 help is open, mouse selection is off. Selecting over the approval card is allowed (it's only text) and never counts as a key for the card.

### 2. Agent prompt editing and history

- `PanelUi` gets `cursor: number` (index in code points into `input`). Typing inserts at the cursor; Backspace deletes before it; paste inserts at it.
- Keys in the panel input, card idle or absent (`plainBytes`): `←`/`→` move one code point, `Home`/`End` go to start and end. Handle both normal (`\x1b[D`) and application-cursor (`\x1bOD`, `\x1bOH`, `\x1bOF`) forms, plus `\x1b[1~`/`\x1b[4~`.
- The same ←/→/Home/End also work in the card's edit and deny inputs.
- `↑`/`↓` step through prompts submitted this session, newest first. On the first ↑ the current draft is saved, and ↓ past the newest restores it. Consecutive duplicate prompts are stored once. History lives in memory only and isn't touched by clear.
- `drawPanel` places the terminal cursor at the input cursor position, wide characters and wrapping included. Its returned `cursor` must follow `ui.cursor`, not the end of the input.
- When the panel isn't focused, arrows go to the PTY as today.

### 3. Clear agent chat

- `/clear` submitted from the panel input (exact text, trimmed) and `Ctrl+L` (`\x0c`) while the panel input has focus both clear.
- Clearing empties the `transcript` array, sets `history = []` (the `ModelMessage[]` in `app.ts`), sets `sessionId = null` so a gateway keyed on `config.sessionHeader` also starts fresh *(my call)*, resets `agentScroll` to 0, and adds one `note` line: `chat cleared`.
- While the agent is busy, clear does nothing except a status note telling the user to press Esc to cancel first. `/clear` never gets sent to the model.
- *Builder's call:* whether "allow for this task" state needs a reset. It's per task, so it should already be gone when idle; confirm that.

### 4. Approval card: "B · Gutter bar"

The card stays at the bottom of the agent strip, above the input line. Every card row starts with an amber (`38;5;178`) `▌` and a space; the content area is `innerCols - 2`.

```
▌ wants to type into pwsh
▌
▌   ls | sort Length -desc ⏎
▌
▌  y  approve (Enter)   e edit  n deny  a all
```

- Header: `wants to type into` in bold amber, then the target in bright white (escaped with `escapeControl` as today).
- One blank gutter row above and below the payload when there's room. Drop them first when space is tight (see the budget below).
- Payload: indented two more columns. Text tokens in bright white with no quotes. Key tokens as reversed amber chips with a space of padding (` ⏎ `; keep `displayTokens` labels). Wrapped rows keep the indent.
- Exact keys stay visible without quotes: leading and trailing spaces of a text token are drawn as a dim `·`, and a single separator space goes only between a text token and a chip, never inside text. A trailing space before Enter (`ls·` then ` ⏎ `) can't hide. *(My call: the card's promise is that you see exactly what gets typed.)*
- Action row: `y` as a filled chip (amber reverse, bold), then `approve (Enter)` in white. Then `e`, `n`, `a` in bold amber, each followed by its word in dim (`edit`, `deny`, `all`). On narrow widths, wrap like today's `CARD_ACTIONS`.
- Edit and deny modes: header and gutter stay, and the action row becomes a hint (`Enter save · Esc cancel` / `Enter deny · Esc cancel`); the input line is where they type, as today.
- Truncated card (doesn't fit): header row plus the existing notice text, both with the gutter. `y`/`a`/Enter stay disabled while truncated, as today.
- Space budget, when rows are short: drop the blank rows first, then the existing truncation path applies.

### 5. Enter = approve

- In `cardBytes`, when the card isn't in edit or deny mode and isn't truncated, `\r` acts like `y`.
- In `app.ts`, `blocksApprove` must count `\r` as an approve key in this state: add it to the approve check with `seenAt = cardVisibleAt` and the same `APPROVAL_QUIET_MS` rule. Edit/deny Enter keeps its existing `inputVisibleAt` path unchanged.
- Help text (`src/render/help.ts`) and README mention Enter.

## Tests (one per behavior, existing suites)

- `tests/focus.test.ts`: cursor moves, insert at cursor, history ↑/↓ with draft restore, `/clear` action, Ctrl+L, Enter approves an idle card, Enter is ignored while truncated.
- `tests/app-agent.test.ts`: Enter right after a card appears is blocked by the quiet guard; after it, Enter approves; clear empties history (the next model call gets no old messages).
- `tests/render/panel.test.ts`: gutter on every card row, payload indent, chip rendering, cursor placed mid-input with a wide character before it.
- New `tests/mouse-select.test.ts` (or inside `app.test.ts`): text from a frame range (wide chars, trailing spaces, multi-row), clamp to pane, click without movement doesn't copy, pass-through when the inner program has mouse tracking.
- `tests/term/modes.test.ts`: `drag` requested whenever the inner mode is `none`, `x10`, or `vt200`, and `any` stays `any`.
- Esc with a selection showing clears it, and the card is still pending.
- Card payload: a token with a trailing space renders `·` before the chip.

## Left to the builder

- Module boundaries: e.g. a pure `src/mouse-select.ts` (state + `selectedText(frame, range)`), wired in `app.ts`.
- Exact chip padding, and whether bright white is `97` or `38;5;255`.
- Exact footer wording for `copied` and the busy-clear note.
- Housekeeping: add `.superpowers/` to `.gitignore`.
