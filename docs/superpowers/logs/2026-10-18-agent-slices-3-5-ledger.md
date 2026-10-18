# SDD ledger — plan: docs/superpowers/plans/2026-10-18-blockterm-agent-slices-3-5.md
Spec: docs/superpowers/specs/2026-10-17-blockterm-design.md. Branch: agent-slices-3-5 (from main 383133f). Implementer: OpenCode lane implementation via relay (controller verifies + commits). Reviewers: Claude sonnet (task), haiku (scoped re-review), opus (final).

## Preflight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1→T2,T3,T8,T9 | Config, LoadResult, configPath, saveConfig | ok |
| T2→T3,T8 | createModel, keyHint, ModelResult | ok |
| T3→T9 | cli setup/doctor; config path resolution | T9 adds BLOCKTERM_CONFIG override in cli — ok, T9 edits cli after T3 |
| T4→T8 | Layout.panel {mode, rect}, Rect | ok; T8 frame borders vs docked panel — Ruling J |
| T5→T6,T8 | parseKeys/keysToBytes/displayTokens, readScreen, session.program/kill, buildSystemPrompt | ok |
| T6→T7,T8 | Decision, AgentEvent, runTask(TaskOptions) | TaskOptions lacks `secrets` though step 3 adds it — Ruling I |
| T7→T8 | PanelUi, Action, reduce | ok |
| T3 self | doctor uses isStepCount | name must exist in ai@7.0.143 — Ruling K |
| T6 self | MockLanguageModelV4 from ai/test | must exist in 7.0.143 — Ruling K |
| T1,T2,T4,T5,T7,T9 self | tests vs code | ok |
| T8 self | composeFrame "optional panel argument" vs drawPanel(cells,…) | ambiguous — Ruling J |

Ruling I: TaskOptions includes `secrets: string[]` (values redacted from error messages/events) — plan step 3 already says so — cost: none.
Ruling J: composeFrame keeps its signature (no panel param) and draws borders from layout.pty; when docked, the right block/outer borders sit at cols 2+pty.cols and 3+pty.cols and the panel rect starts after; app calls drawPanel(frame.cells, …) after composeFrame and before renderDiff; Chrome gains optional footerStatus — cost: none.
Ruling K: if `isStepCount` or `MockLanguageModelV4` don't exist in ai@7.0.143, use the version's actual names (e.g. stepCountIs / MockLanguageModelV3) and report — docs were read from the 7.0.0 tree — cost: none.
Ruling L: scope cuts per plan header (no list_blocks/read_block/run_command/#/explain) — need slice 2 — cost: agent types commands via send_keys.

## Execution
Task 1: implemented by OpenCode (DONE), gates 139 pass/2 skip + typecheck; committed aed9594; review dispatched
Ruling M: owner asked for 'a task for simple update' → Task 10 'blockterm update' (git install: git pull --ff-only, npm install, npm run build; npm install: npm i -g blockterm@latest). Manual command only; spec §3 non-goal 'update checks' still holds — cost if wrong: small command to reshape.
Task 1: minor (deferred): no tmp cleanup on write/rename error; APPDATA='' treated as set; no wrong-type validation tests; "model is required" message for non-string.
Task 1: complete (commits 383133f..aed9594, review clean)
Task 2: implemented by OpenCode (DONE_WITH_CONCERNS: added tsconfig skipLibCheck because @ai-sdk/provider types import untyped json-schema). Gates 147 pass/2 skip + typecheck; committed 7f66488; review dispatched.
Ruling N: accept "skipLibCheck": true over adding @types/json-schema (a dev-only types dep) — standard for third-party d.ts gaps, no runtime effect — cost if wrong: library type errors in node_modules go unchecked (our src still fully checked).
Task 2: minor (deferred): second no-leak test case builds no model; anthropic/openai with apiKeyEnv '' lets the SDK fall back to its own env var.
Task 2: complete (commits 665fcb3..7f66488, review clean)
Task 3: implemented by OpenCode (DONE; moved shellExists to shell.ts to break a cli↔doctor import cycle; piped non-TTY setup may drop last answer). Gates 158 pass/2 skip + typecheck; real 'node dist/cli.js doctor' prints checks, exit 1 without config. Committed b48f7bf; review dispatched
Task 3: review Approved, but Minor #2 (doctor surfaces raw provider error, which may echo the key) violates the Global Constraint "key value never in error messages" → Ruling O: treat as a confirmed gap, fix round 1; fold in Minor #1 (piped stdin readline race) since same files — cost: one small round.
Task 3: minor (deferred): no tests for openai-compatible empty key / invalid-config / model timeout paths; scripted Io duplicates default logic.
Task 3: fix round 1/5 (2 addressed, 0 open; commits b48f7bf..0ee84eb)
Task 3: minor (deferred): fused line in tests/doctor.test.ts (format); createIo ask() calls rl.prompt() before checking closed (may throw after close); single pending ask only; setup menu lacks trailing newline.
Task 3: complete (commits 7f66488..0ee84eb, review clean after 1 fix round)
Task 4: implemented by OpenCode; committed c8ec74f; review dispatched
Task 4: minor (deferred): no 99/100-col dock boundary test; tiny-host test doesn't assert overlay/rect-in-host; magic numbers.
Task 4: complete (commits 0ee84eb..c8ec74f, review clean)
Task 5: implemented by OpenCode; committed 7467d8d; review dispatched
Task 5: review Approved; Minor #1 (C1 controls, bidi overrides, zero-width/line separators not escaped in displayTokens) conflicts with spec §4 anti-goal "approval UI must make exactly what will be typed impossible to misread" → Ruling P: confirmed gap, fix round 1 together with #2 (escape backslash) and #3 (own-key lookup) — cost: one small round.
Task 5: minor (deferred): readScrollback doesn't trim trailing blank rows / fractional lines; waitForQuiet has no abort signal (CARRY TO TASK 6: abort shouldn't wait 15 s); cwd/program interpolated into system prompt unsanitised.
Task 5: fix round 1/5 (3 addressed, 0 open; commits 7467d8d..28fbc63)
Task 5: minor (deferred, CARRY TO FINAL REVIEW — security): isHidden misses Unicode tag block U+E0000–E007F (invisible-ASCII smuggling), U+2060–2064, U+00AD, variation selectors, U+180E, U+3164, U+FFF9–FFFB; Object.hasOwn path not directly tested; ZWJ emoji render split in card.
Task 5: complete (commits c8ec74f..28fbc63, review clean after 1 fix round)
Task 6: implemented by OpenCode (DONE_WITH_CONCERNS: SDK 'v2 compatibility mode' warning in test output). Gates 207 pass/2 skip + typecheck; committed 25cf2b0; review dispatched (opus — security path)
Task 6: review (opus) → Needs fixes. Critical C-1: streamText default onError console.error prints raw key to stderr (user's screen). Important I-1: abort/approve failure leave tool calls without results (history rejected by providers next turn); I-2: SDK-invalid tool calls get a duplicate out-of-order result; I-3: missing tests (mixed read+write step, two writes, edit fails to parse, history valid after abort/limit, no console leak). Minors M-1 time limit only between iterations, M-2 abort listener leak, M-3 waitForQuiet ignores abort — folded into the round (cheap). M-4 per-delta redaction, M-5 card must be drawn from raw approve() keys not redacted event (CARRY TO TASK 8).
OWNER DIRECTIVE (2026-10-18): after this plan, finish the whole project so the product is ready to use; run on autopilot; use OpenCode delegation for every implementation step and move on when each completes. Remaining after this plan: slice 2 (blocks + shell integration incl. list_blocks/read_block/run_command), slice 6 (# quick suggest, Explain error), slice 7 (PS 5.1/Git Bash integration, block selection/actions/copy, F1 help), slice 8 (packaging/prebuilds, README, release doc, CI clean-install). Stop only for: npm publish (needs owner's npm account/2FA), destructive ops, security-sensitive actions.
Task 6: fix round 1/5 (C-1, I-1, I-2, I-3×4, M-1..M-3 addressed; commits 25cf2b0..330741b)
Ruling Q: re-review out-of-scope note "allowRest auto-path doesn't check signal.aborted → after Esc, later auto-approved send_keys in the same step still write" is a real safety gap (user cancelled, agent keeps typing) → fix round 2, plus redact the error text stored in history — cost: one tiny round.
Task 6: minor (deferred): 25-limit test uses read_screen only; mixed invalid+valid step gives two consecutive tool messages; M-1/M-2 untested.
Task 6: fix round 2/5 (2 addressed, 0 open; commits 330741b..def4d34)
Task 6: minor (deferred): dead abort check at loop.ts:132; parse-error/denial text stored unredacted (low risk); no isolated test for entry abort guard. CARRY TO TASK 8: card must show raw approve() keys (M-5), not the redacted event.
Task 6: complete (commits 28fbc63..def4d34, review clean after 2 fix rounds)
Task 7: implemented by OpenCode; committed 5f42eb7; review dispatched
Task 7: minor (deferred, CARRY TO FINAL REVIEW): empty edit + Enter approves keys '' (should be no-op/deny); mid-chunk escape sequences only partly skipped (could leak '[A' into input; card-key risk low); pasted text not sanitized into input line; missing tests yy/y\r/paste-with-card/empty edit/n+Esc.
Task 7: complete (commits def4d34..5f42eb7, review clean)
Task 8: implemented by OpenCode (DONE; concerns: card payload truncates instead of wrapping — likely Important vs spec §4/§5.6; overlay open does a same-size PTY resize; PanelView adds model label). Gates 253 pass/2 skip + typecheck; slice-1 smoke still passes; headless ctrl+k without config shows panel + "Run `blockterm setup`" + footer "run blockterm setup". Committed c14b0b8. REVIEW NOT YET DISPATCHED (usage limit).
RESUME HERE: run task review for Task 8 (review package 5f42eb7..HEAD), fix the card-truncation + triple border "│││" seam, then Task 9 (e2e fake OpenAI + docs/site), Task 10 (blockterm update), final review, merge, then slices 2, 6, 7, 8 per OWNER DIRECTIVE.
Task 8: review (opus) → Needs fixes. Critical 1: card truncates payload (anti-goal §4). Important 2: untrusted panel text (model output, input, target) written to host unfiltered → control-sequence injection; 3: focus events (1004) dropped — slice-1 regression; 4 [plan-mandated]: overlay open does same-size PTY resize; 5 [plan-mandated, Ruling J]: docked seam │││ and no right border.
Ruling R: items 4 and 5 — spec wins over plan text: resize only when the PTY size changes; when docked the panel drops its own left │ (frame's border column separates) and keeps the host's last column for the outer │ — cost: none.
Ruling S: fold Minor 6 (PTY cursor and mouse go to the PTY under an open overlay) and Minor 8 (submit without catch) into the round — cheap, user-visible.
Task 8: minor (deferred): footer `set <VAR>` only after first submit (lazy model); transcript rewrapped every frame; charWidth treats combining/zero-width as 1; §5.6 "card still shown briefly for each auto action" only a transcript note.
Task 8: fix round 1/5 FAILED — OpenCode session degenerated (repeated 'Let me write'), no files changed. Round 2: fresh OpenCode session with brief + report + same findings.
Task 8: fix round 2/5 done by fresh OpenCode session (7 items), gates 263 pass; committed a75f139; re-review dispatched
Task 8: re-review round 2 → 6 of 7 addressed; item 1 partial: New Breakage A — a truncated card ("…(N more)") hides the payload tail and the y/e/n/a hints but 'y'/'a' still approve. Ruling T: when the card doesn't fit, 'y' and 'a' are disabled (only e/n/Esc work) and the card says why; plus card for unparseable keys shows the parse error text — cost: user must widen the window or edit to approve very long payloads.
Task 8: minor (deferred): escapeControl doubles backslashes in transcript/input (display-only).
Task 8: fix round 3/5 (A, C addressed; commits a75f139..c09e7df). New low-severity gap: a 'y' arriving before the first render of a new card (type-ahead/paste, <16 ms) approves an undrawn card.
Ruling U: round 4 uses a fresh OpenCode session on the owner's lane model (skill prefers a more capable model for rounds 4–5, but the owner directed OpenCode for every step and the lane has no stronger flat-rate model) — cost: if it stalls, round 5 escalates to a Claude implementer subagent with a ledger note.
Out-of-scope note verified: invalid keys approved with 'y' are re-parsed in loop.ts and rejected with status error, nothing written — no action.
Task 8: fix round 4/5 (1 addressed, 0 open; commits c09e7df..c0dfe76)
Task 8: minor (deferred): round-4 test comment inaccurate / one vacuous assertion / toContain weak.
Task 8: complete (commits 5f42eb7..c0dfe76, review clean after 4 fix rounds)
Task 9: implemented by OpenCode (DONE; also passed loaded config into runApp). Gates 271 pass/2 skip; real e2e through @ai-sdk/openai-compatible + fake server green; committed c31c782; review dispatched
Task 9: review Approved; Important (a): e2e AGENT_OK wait isn't discriminating (command line echo contains it) → Ruling V: fold the fix (/^AGENT_OK\s*$/m) and the stale README intro (claims blocks/# exist) into the Task 10 dispatch, reviewed with Task 10 — cost: Task 10 review covers two extra small hunks.
Task 9: minor (deferred): startServer awaited outside try (hang/leak if fixture fails).
Task 9: complete (commits c0dfe76..c31c782, review approved; (a) carried to Task 10)
Task 10: minor (deferred, CARRY TO FINAL REVIEW): DEP0190 deprecation warning on Windows for npm.cmd with shell:true (fix: spawn cmd.exe /d /s /c npm.cmd …); spawn error swallowed → misleading ff-only hint when git missing.
Task 10: complete (commits c31c782..5f6065c, review clean; includes Task 9 carried fixes)
Final review: dispatched (opus)
Final review (opus): With fixes. Critical #1 edit field approves text the user can't see (single-row input truncated). Important #2 type-ahead in panel approves card (y/a mid-word); #3 overlay/panel never close (80-col hosts lose the terminal) — spec §5.7 Esc closes idle panel; #4 isHidden gaps (tags, variation selectors, Cf/Co/Cn…); #5 key pasted at apiKeyEnv prompt saved and displayed.
Ruling W: #3 — spec §5.7 wins over plan text: Esc on an idle panel with no card closes it (open:false, focus terminal, layout-changed); the overlay is drawn (and swallows mouse) only while the panel has focus; hiding the overlay resets card.truncated = true — cost: users reopen with ctrl+k.
Ruling X: #2 — on card arrival clear ui.input and ignore y/a until the card has been drawn AND 400 ms have passed with no keystroke since it appeared — cost: a 0.4 s pause before approving.
Ruling Y: one final fix wave also takes cheap minors #6 (doctor hint on provider errors), #8 (AI_SDK_LOG_WARNINGS=false), #9 (\b in SK_TOKEN), #10 (escape title), #11 (site/README honesty), #12 (setup resets provider-specific fields on provider switch), #13 (lazy import of app.js in cli; cmd.exe /d /s /c for npm.cmd; spawn error message instead of diverged hint) — cost: larger single wave.
Final fix wave: done by OpenCode (12 items), 304 pass; committed 5cd52ae; scoped re-review dispatched
Final fix re-review: all items addressed except New Breakage A (Critical): 'e' then Enter approves keys never seen (inputTruncated stale/undefined until edit field drawn; gate covers y/a only) → type-ahead "make\r" or "e\r" approves.
Ruling Z: process says no second fix wave, but this is a load-bearing safety hole and the owner's autopilot directive is to make the product ready; apply one targeted fix (smallest change) and re-review it before merge — cost: one more small round.
Final fix round 2 (f2779f1): 'e'+Enter hole ADDRESSED. Re-review (opus, probes against dist) found 2 confirmed residual invariant violations: (1) cardShownAt starts while the card is truncated → resize that makes it fit allows y/a within ~30 ms of the keys appearing; (2) same for the edit field (inputShown boolean survives resize; Enter gate times from last keystroke not from draw).
Ruling AA: same justification as Ruling Z — one more targeted fix: replace cardShownAt/inputShown with timestamps set ONLY when the full card / full edit field is drawn untruncated, cleared on any truncation change or content change; approve requires now − shownAt ≥ 400 ms AND now − lastKeyAt ≥ 400 ms — cost: one small round.
Final fix round 3 (51fba1d): both resize holes ADDRESSED; re-review (opus) found no remaining invariant violations. Branch ready to merge.
