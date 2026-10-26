# SDD ledger — plan: docs/superpowers/plans/2026-10-26-blockterm-arabic-rtl.md

Spec: docs/superpowers/specs/2026-10-26-blockterm-arabic-rtl-design.md. Branch feat/arabic-rtl (start 105f299, from origin/main 080101e). Implementer: OpenCode opencode-go/deepseek-v4.1-flash (owner lane); reviewers: Claude subagents.

## Preflight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1–T3 | reorderSpan/visualCol/LogicalRow → composeFrame, selectedText | consistent |
| T1–T4 | same → drawPanel; card base 'ltr' | consistent |
| T2–T3 | rtlMode → app computes rtl once | consistent |
| T3–T4 | Frame.logical (shell rows) → drawPanel adds panel rows; app passes frame.logical | consistent; rows disjoint (pty rows vs panel rect) |
| T1 self | test values: مرحبا shaped FEE3 FEAE FEA3 FE92 FE8E; mixed test fixed to final م FEE2 | consistent |
| T2 self | check order explicit > bidi hosts > plain hosts | consistent |
| T3 self | cursor end = cursor's own col | consistent |
| T4 self | cursor:1 → prompt+0; end → prompt+2 | consistent |
Scan clean, no rulings. Plan rulings carried: per-row paragraph for shell/transcript; no lam-alef ligature.
Task 1: implemented by OpenCode (DONE), gates 605 pass/4 skip + typecheck; committed.
Ruling: plan's `echo مرحبا 123` expectation was wrong — UAX #9 W2 turns digits after Arabic into AN, so the visual order is `echo 123 <arabic>` (as browsers show it); implementer's corrected value stands — cost if wrong: none, it follows the standard.
Ruling: bidi-js loaded via createRequire (no esModuleInterop in tsconfig) instead of default import — runtime same — cost if wrong: one import line.
Task 1: review (opus) Spec ❌ Needs fixes. Important 1: trailing space padding joins the RTL paragraph → RTL rows right-align. Important 2: cells with letter+folded haraka not shaped.
Ruling: plan said placeholder `a` for L/neutral; reviewer shows neutral emoji then splits RTL runs — use a placeholder of the cell's own class (AL→'ا', R→'א', L→'a', neutral→'!'; digits by their class) — cost if wrong: none beyond a few lines.
Task 1: ⚠️ reorderSpan overwrites logical record if called twice on one row — plan calls it once per row (card: whole row after gutter); carried to Tasks 3/4 dispatch as a constraint.
Task 1: fix round 1/5 (4 addressed, 0 open — padding trim, folded harakat, placeholder class, ZWJ/063B/lam-alef; commits 79d0af7..2dddb2d)
Task 1: minor (deferred): padding trim only treats ch ' ' as blank (frames pad with ' ', so fine); minor gaps from review — no test for col>0 span identity map, non-RTL non-ASCII row.
Task 1: complete (commits 105f299..2dddb2d, review clean)
Task 2: implemented by OpenCode (DONE), gates 631 pass/4 skip + typecheck; committed
Task 2: review (sonnet) ❌ Important: win32 checked before TERM_PROGRAM hosts → VS Code/WezTerm/Alacritty on Windows report 'Windows console' + font hint.
Task 2: fix round 1/5 (1 addressed, 0 open — detection order + constant; commits 90b535f..b5a3ec2)
Task 2: complete (commits 2dddb2d..b5a3ec2, review clean)
Task 3: implemented by OpenCode (DONE), gates 640 pass/4 skip + typecheck; committed. Note: working tree had been switched to main (owner pull); OpenCode checked feat/arabic-rtl back out before working.
Task 3: review (opus) Spec ✅, Approved. ⚠️ session.view is 'fullscreen' iff buffer.active.type === 'alternate' (session.ts:85) — resolved.
Task 3: minor (deferred, FINAL REVIEW: weigh): block header with an all-Arabic command flips (status left, `$` right) under per-row first-strong — candidate: header rows base 'ltr'.
Task 3: minor (deferred): no test on integrated composeBlocks path; end-of-run cursor test passes without remap; dead undefined guard in selectedText.
Task 3: complete (commits b5a3ec2..62bcb85, review clean)
Task 4: implemented by OpenCode (DONE), gates 646 pass/4 skip + typecheck; committed
Task 4: review (opus) Spec ✅, Approved. ⚠️ manual Windows Terminal check — orchestrator/owner to do.
Task 4: minor (deferred, FINAL REVIEW: weigh — approval-adjacent): card edit/deny input uses base 'auto'; an edited string like `مرحبا<Enter>` draws `<Enter>` left of the Arabic, and edit-mode Enter approves what's in that input directly. Candidate: base 'ltr' for the input while card.editing/denying.
Task 4: minor (deferred): input row logical snapshot taken before status drawn (copy shows blanks over status); no RTL tests for `ls مرحبا<Enter>` card, · markers, wrapped payload, edit-mode input; inputLineWidths computed when rtl off.
Task 4: note: per-row rulings — word split across wrapped rows loses joining at the break; `you` line starting with Arabic moves its ❯ lead right.
Task 4: complete (commits 62bcb85..4b1a08f, review clean)
Final review (opus): Ready with fixes. Important: card edit input uses 'auto' → `<Enter>` drawn left of Arabic while Enter approves it. Minor/owner: all-Arabic block headers flip; shell rows under first-strong scramble columnar output (ls, tables) and drop indentation; pack-install CI doesn't load bidi-js.
Ruling: edit-mode input (card.editing) uses base 'ltr'; deny reason keeps 'auto' — approval display must match the card — cost if wrong: none.
Ruling: shell rows (blocks view, incl. headers) use base 'ltr' instead of first-strong — terminal convention keeps columns, indentation and block headers intact (also fixes the header flip); Arabic runs are still shaped and reversed in place. Agent transcript and input keep 'auto' (phone-like) — cost if wrong: a mixed Arabic+English sentence printed by a shell program reads in left-to-right word order; owner can ask to switch back.
Final fix wave: re-review (sonnet) all 3 addressed, no new breakage (commits 4b1a08f..c2d6a18).
Final: parked — Arabic-command block header: trailing status (`✓ 0.2s`) still joins the RTL run under 'ltr' (digits after Arabic become AN) — Ruling: accepted residual, `$` stays left; rare (command names are usually Latin).
Final: minor (deferred): pack-install CI doesn't import dist/render/rtl.js (bidi-js); manual Windows Terminal check pending (owner).
