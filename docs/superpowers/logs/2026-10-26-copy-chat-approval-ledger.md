# SDD ledger — plan: docs/superpowers/plans/2026-10-26-blockterm-copy-chat-approval.md

Spec: docs/superpowers/specs/2026-10-26-blockterm-copy-chat-approval-design.md. Branch feat/copy-chat-approval (start 840bf95). Implementer: OpenCode opencode-go/deepseek-v4.1-flash (owner lane); reviewers: Claude subagents.

## Preflight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1–T2 focus.ts | T1 cursor/history fields; T2 adds /clear branch before submit, keeps history | consistent |
| T1–T3 focus.ts cardBytes, panel.ts | T1 cursor keys in edit/deny + cursor draw; T3 \r in non-edit branch + card builder | consistent; T3 must keep T1 cursor code |
| T2–T3 help.ts/README | separate lines | consistent |
| T3–T5 Esc | T3 Esc deny unchanged; T5 Esc consumed only with highlight | consistent |
| T4–T5 mouse-select | signatures match | consistent |
| T1 self | tests vs code (optional cursor = end) | consistent |
| T2 self | model=null forces new sessionId via ensureModel | consistent |
| T3 self | row math at 40 cols checked (6 card rows, a all wraps) | consistent |
| T4 self | frameOf helper defined in test | consistent |
| T5 self | hostModesFrom loses 3rd arg; call site in app.ts updated in same task | consistent |
Scan clean, no rulings.
Task 1: implemented by OpenCode (DONE), gates re-run 557 pass/4 skip + typecheck; committed 51560e0; review dispatched (sonnet)
Task 1: review (sonnet) Spec ✅, Approved. ⚠️ unfocused arrows → PTY: reduce routes focus==='terminal' bytes before plainBytes (unchanged code) — resolved.
Task 1: minor (deferred): historyAt/draft not cleared when a card resets input (decide / n / e) — stale history after card.
Task 1: minor (deferred): wrapped-input cursor test only bounds row range; no tests for ↑/↓ no-op in deny / non-editing card.
Task 1: complete (commits 840bf95..51560e0, review clean)
Task 2: implemented by OpenCode (DONE), gates 561 pass/4 skip + typecheck; committed
Task 2: review (sonnet) Spec ✅, Approved. ⚠️ ctrl+l with pending card: cardBytes ignores non-action chars (unchanged) — resolved; session id change covered by app test.
Task 2: minor (deferred, FINAL REVIEW: weigh): footer precedence swap lets selectionNotice override statusText; ttl-0 notices ('not at an idle prompt', 'multi-line rerun…') can hide 'approval pending (ctrl+k)'. Candidate fix: override only when status is 'agent busy'.
Task 2: minor (deferred): clear test's double ctrl+k undocumented; busy test doesn't check note expiry.
Task 2: complete (commits 51560e0..b64690a, review clean)
Task 3: implemented by OpenCode (DONE), gates 569 pass/4 skip + typecheck; committed
Task 3: review (opus) Spec ✅, Approved; no Enter-guard bypass found (chunks, paste, e\r/n\r, burst, truncation).
Ruling: edit/deny hints read `Enter approve · Esc deny` / `Enter deny · Esc deny` (plan) not spec's `Esc cancel` — Esc denies in both modes today (cardBytes), so "cancel" would mislead on the approval card — cost if wrong: one-line copy change.
Task 3: minor (deferred, FINAL REVIEW: weigh): long-payload wrap test now strips all whitespace — can't catch dropped/doubled spaces in payload.
Task 3: minor (deferred): same-tick test asserts only absence; duplicated bold amber constant; `editing` var also covers deny.
Task 3: note for owner: idle card ignores printable keys but Enter approves after 400ms quiet — a slow typist pressing Enter from habit could approve. Possible tightening: block \r if any printable key arrived after cardVisibleAt.
Task 3: complete (commits b64690a..ea086be, review clean)
Task 4: implemented by OpenCode (DONE), gates 576 pass/4 skip + typecheck; committed.
Ruling: plan's multi-row test had head.col 6 but 'x' sits at col 7; implementer used 7 — plan arithmetic slip, inclusive head semantics stand — cost if wrong: none (test-only).
Task 4: review (sonnet) Spec ✅, Approved. ⚠️ Gesture rules (moved/click) live in Task 5 wiring — carried there.
Task 4: minor (deferred): unreachable agent fallback in paneRows; no wide-char highlight / agent-pane clamp / middle-row tests.
Task 4: complete (commits ea086be..1dda9f3, review clean)
Task 5: implemented by OpenCode (DONE), gates 582 pass/4 skip + typecheck; committed
Task 5: review (opus) Spec ❌, Needs fixes. Important 1: stale mouseSel after release captures later motion/release (vim pass-through broken). Important 2: always-drag host mode drops wheel in fullscreen without tracking + non-integrated shells (host alt-scroll used to send arrows).
Ruling: Important 2 — keep spec's always-drag host mode and emulate the host's alternate scroll: shell-area wheel with inner tracking 'none' and not (blocks view && integrated) sends 3 Up/Down arrow presses to the PTY (app-cursor aware) — reproduces what the host did while blockterm sits in the host alt screen — cost if wrong: scroll step differs from the host's own (usually 3).
Task 5: minor (deferred): clamped-release test checks only startsWith; no below-agent-strip release test; no "other key clears then acts" test; stale wheelEvent comment.
Task 5: fix round 1/5 (3 addressed, 0 open — stale mouseSel, wheel alt-scroll emulation, comment; commits 2bb241e..cb644cb)
Task 5: complete (commits 1dda9f3..cb644cb, review clean)
Final review (opus): Ready with fixes. Important: (1) Enter approves card while a draft sits on the input line / printable keys ignored after card visible; (2) plain click leaves 1-cell highlight that eats next Esc. Minor to fix: footer precedence, Esc-clear skips lastKeyAt, long-payload test strips whitespace, wheel arrow emulation while panel focused. Rest stay deferred.
Ruling: Enter (not y/a) approves only when ui.input === '' and no printable key was ignored since the card became visible — anti-goal "Enter meant for the panel prompt must never approve" — cost if wrong: user must clear the draft or use y.
Ruling: fix wave stopped clearing ui.input when a card appears (to keep a draft). Revert that: card creation clears input as before — a kept draft can't be edited on an idle card (DEL ignored) and would permanently disable Enter while the card says "approve (Enter)"; the ignored-key flag still blocks typing-past — cost if wrong: a draft typed during a busy turn is lost when a card appears (pre-branch behavior).
Final fix wave: re-review (opus) all 6 addressed, no new Critical/Important (commits cb644cb..21ca682).
Final: parked — paste onto an idle card is dropped without setting `ignored`, so paste-then-Enter after 400 ms approves — Ruling: real, residual, surfaced to owner (one-line fix: set ignored in panelPaste for idle cards); no second fix wave per process.
Final: minor (deferred): no single-chunk "x\r" test; redundant ui.input === '' checks.
