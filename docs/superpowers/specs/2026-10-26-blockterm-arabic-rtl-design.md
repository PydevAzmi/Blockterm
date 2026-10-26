# blockterm: readable Arabic (RTL) in input and output

Date: 2026-10-26. Builds on `2026-10-26-blockterm-copy-chat-approval-design.md` (agent input cursor, mouse selection).

## Why

The owner typed Arabic on the agent line. The input and the agent's Arabic reply were both unreadable: separate letters, in reverse order.

The cause: hosts like Windows Terminal draw each row left to right, one character per cell, with no bidi and no Arabic shaping. blockterm draws its own screen cell by cell (`composeFrame`, then `renderDiff` with cursor moves), so even a host that could shape a whole run never gets one. blockterm has to do both itself.

Success: Arabic reads correctly, letters joined and runs right to left, wherever blockterm draws text. That covers the agent input, the agent replies, the approval card, and shell output in the blocks view. Mixed lines (Arabic with English words, paths and numbers) read the way a phone or Claude's web app shows them.

## Goals

- Arabic shaping: each letter takes its contextual form (isolated, initial, medial, final).
- Bidi display: right-to-left runs are drawn in visual order. LTR runs (Latin, digits, paths) inside them stay left to right.
- Applies to:
  - the agent panel: transcript, input line, approval card;
  - the shell area in the blocks view;
  - block command headers.
- Display only. The underlying text stays logical everywhere else: what the shell receives, what the agent reads from the screen (`src/agent/screen.ts` reads the xterm buffer), what gets copied, and what gets approved.
- The agent input cursor follows logical order. ←/→ move one character back or forward in the text; on screen the cursor lands at that character's visual position.
- Works on Windows Terminal and the classic Windows console. Also works on any host that does no bidi of its own (VS Code's terminal, iTerm2, Alacritty, WezTerm by default).

## Non-goals

- Fullscreen programs (alt screen: vim, less, htop). They own their layout and cursor, and some do RTL themselves (vim `rightleft`). Reordering their rows would break them, so they're drawn untouched.
- Paragraph-level RTL layout, i.e. right-aligning a whole line. Rows stay left-anchored; only run order and shaping change. *(My call: right-aligning shell output would break column alignment.)*
- Hebrew/Persian/Urdu letter forms beyond what bidi gives for free. Hebrew needs no shaping, so it gets correct order automatically. Persian/Urdu letters in the Arabic block get shaped if the table covers them. *(Builder's call how far the table goes; Arabic is required.)*
- Changing what the PTY or the model sees.

## Anti-goals

- **Double reversal.** On a host that already does bidi (GNOME Terminal/VTE, Konsole, mintty, Apple Terminal), blockterm must not reorder too, or the text flips back. Default detection must keep those hosts untouched.
- **Approval card ambiguity.** The card's promise is "you see exactly what gets typed". The payload is displayed shaped and in visual order, but the keys sent are the logical text. The `·` edge-space markers and key chips must still be correct. A chip such as `⏎ Enter` must never move into the middle of an RTL run in a way that misstates the order of keys. *(Builder: key chips are LTR-neutral boundaries, so each text token is reordered on its own.)*
- **Shifting columns.** Shaping must not change the cell count of a row, because that would break wrapping, mouse hit-testing and diffing. This rules out the lam-alef ligature, which turns 2 cells into 1, unless it's padded to keep the width. *(Builder's call: skip the ligature or pad it.)*
- **Copy giving reversed or presentation-form text.** Dragging over Arabic must copy normal logical Arabic.

## Constraints

- TypeScript, Node 24. Run node as `fnm exec --using=24.19.0 -- npm.cmd …` from Git Bash.
- New runtime dependencies need the owner's OK (see the open question below).
- `Frame.cells` are `{ ch, width, sgr }`, and `renderDiff` diffs cells by index. The reordering has to produce a frame of the same shape.
- The mouse-selection code (`src/mouse-select.ts`) reads `Frame.cells` for copy and highlight.
- The approval guard (`cardVisibleAt`, 400 ms quiet, Enter rules) stays untouched.

## Design

### Where it runs

There's one display pass, `visualRow(cells) -> { cells, map }`, applied per row region after the frame is composed and before `renderDiff`:
- the shell rows in the blocks view (not in fullscreen);
- the agent panel rows (transcript, card, input line).

The mode line and footer are left alone; blockterm's own chrome is ASCII. The pass runs only on rows that contain a strong RTL character (fast path).

`map` gives, for each visual cell, the logical column it came from. It's kept per row so these can translate visual to logical:
- the agent input cursor (logical to visual);
- mouse selection copy (visual range to logical text);
- highlight.

### Bidi

- **Base direction follows the first strong character** (UAX #9 P2/P3), as phones and Claude's web app do. A line that starts with Arabic gets an RTL base, so in `مرحبا hello عالم` the word `مرحبا` comes first for a right-to-left reader, and trailing `؟ ! .` land at the left end. A paragraph with no strong character is LTR. Rows stay left-anchored (no right alignment). *(My call, from "read like a phone or Claude".)*
- Direction is decided once per logical paragraph and shared by its wrapped rows:
  - a transcript entry segment (the text between `\n`);
  - the agent input string;
  - a card payload text token;
  - an xterm logical line, i.e. rows joined by `isWrapped`.

  *(My call.)*
- Resolve levels with the Unicode Bidi Algorithm (UAX #9) for one line: digits stay LTR inside RTL, neutrals between RTL characters join them, and brackets mirror (`(` ↔ `)`) in RTL runs.
- Wide (width-2) cells and their width-0 continuation cells move as a unit.
- SGR moves with its character.

### Shaping

- For each Arabic letter, pick its contextual form from its joining type and its neighbours in logical order: Unicode ArabicShaping joining types D/R/U/T. Transparent marks (harakat) don't break joining.
- Emit the Arabic Presentation Forms-B code point for that form. Keep one cell per letter.
- Diacritics (harakat) keep their own cell, or fold into the preceding cell's `ch` as a combining mark. *(Builder's call; the width must stay consistent with xterm's cell for that character.)*

### Agent input

- The input stays a logical string, with the cursor as a logical code-point index (Task 1 of the previous branch).
- `drawPanel` lays out the wrapped input lines in logical order, then applies `visualRow` per line, and places the terminal cursor at the visual column of the logical cursor.
- **Cursor rule:** the block cursor sits on the visual cell of the character at the logical cursor index, i.e. the character the next ← would step over to the right. At the end of the input it sits one cell right of the right-most input cell, which is where terminals usually park it. *(My call: simple and predictable. Cost: at the end of an all-Arabic input the cursor sits right of the text, not left where the next letter will appear.)*
  - Example: input `مر` with an RTL base is drawn `رم` (ر in column 0, م in column 1). After `←` the cursor index is 1 and the character there is ر, so the cursor is on column 0. At index 2 (end of input) the cursor is on column 2.
- **The shell prompt line is remapped the same way.** In the blocks view, the shell cursor (xterm `cursorX`) is mapped through that row's `map` to the visual cell of the character at `cursorX`. Typing Arabic at a PSReadLine or bash prompt reads correctly, and the cursor stays on the right character. This also applies to the non-integrated blocks view (raw mirror rows). *(My call.)*

### Mouse selection

- Selection is still dragged in visual coordinates, and the highlight is drawn over the visual cells.
- `selectedText` maps each selected row's visual cells back to logical columns through `map`. It takes the logical span from the smallest to the largest logical column and reads the logical (unshaped) characters. *(ponytail: a selection covering part of an RTL run inside a longer LTR line may copy a slightly wider logical span; that's acceptable.)*

### When it's on

The config key is `rtl: "auto" | "on" | "off"` and defaults to `auto`.

`auto` turns it on when the host is known to do no bidi:
- `WT_SESSION` is set (Windows Terminal);
- win32 without `WT_SESSION` (the classic console);
- `TERM_PROGRAM` is `vscode`, `iTerm.app`, `WezTerm` or `alacritty`.

`auto` turns it off when the host does bidi itself: `VTE_VERSION`, `KONSOLE_VERSION`, `TERM_PROGRAM=mintty` or `Apple_Terminal`.

Any other host is off. *(Builder: verify Apple Terminal and iTerm2 behavior; adjust the lists, never the rule "off when unsure".)*

`blockterm doctor` prints the decision, e.g. `rtl: on (Windows Terminal)`.

**Fonts.**
- Shaped output needs a font with Arabic Presentation Forms-B.
  - Windows Terminal falls back to another font automatically.
  - The classic console (conhost) does no font fallback, and Consolas has no Arabic, so Arabic shows as boxes there unless the user picks a font with Arabic. That happens with or without this feature.
- `auto` stays on for conhost. On win32 without `WT_SESSION`, `doctor` adds the hint: `rtl: on (Windows console) — Arabic needs a font with Arabic glyphs, or use Windows Terminal`. *(My call.)*
- Builder: confirm Cascadia Mono/Code renders the FE70–FEFF forms in Windows Terminal (directly or through fallback).

## Tests

- **Pure bidi and shaping:**
  - `مرحبا` becomes shaped forms in reversed visual order with the same cell count;
  - `echo مرحبا 123` keeps `echo`, then the RTL run, then `123` (with the digits not reversed);
  - a wide CJK character next to Arabic stays a pair;
  - brackets get mirrored inside an RTL run;
  - an ASCII-only row returns unchanged (the same object or equal cells).
- **Panel:**
  - Arabic input draws shaped and reversed;
  - after typing `مر` then `←` the cursor is on input column 0 (the cell of `ر`); at the end of the input it's on input column 2;
  - `مرحبا hello عالم` draws with `عالم` left-most, `hello` in the middle and `مرحبا` right-most.
- **Shell prompt row:** typing `مر` at the prompt draws `رم` with the cursor right of it. After `←` (PSReadLine moves `cursorX` back one) it sits on the cell of `ر`.
- **Card:** the payload `ls مرحبا<Enter>` keeps the `⏎ Enter` chip after the text in visual order, keeps the `·` markers, and approves the logical keys (`ls مرحبا\r`).
- **Shell (blocks view):** `echo مرحبا` output row is drawn shaped and reversed; in fullscreen (alt screen) the same text is untouched.
- **Copy:** dragging over a drawn Arabic row copies the logical text `مرحبا`.
- **Agent screen read:** `screen.ts` text is still logical.
- **Config:** `auto` decisions from each env table entry; `on` and `off` override.

## Owner decision: `bidi-js`

The owner approved adding `bidi-js` as a runtime dependency (2026-10-26).
- Pin it exactly at `"bidi-js": "1.1.0"`.
- What it is: MIT, pure JS, full UAX #9. Its one dependency is `require-from-string`. The package is about 170 KB unpacked.
- Use it for embedding levels (first-strong paragraph direction), reorder segments and mirrored characters.
- Arabic shaping stays a small table written in-repo.
- Builder: confirm `npm pack` and the pack-install CI job still pass with the new dependency.

## Left to the builder

- Module layout. For example, `src/render/rtl.ts` (pure `visualRow`, `shape`, `levels`) plus wiring in `frame.ts`/`panel.ts`/`app.ts`.
- Lam-alef handling, how far harakat are supported, and the Persian/Urdu table coverage.
- Fast-path details and caching per row.
