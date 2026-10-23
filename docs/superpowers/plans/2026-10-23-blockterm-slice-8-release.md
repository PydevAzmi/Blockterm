# Slice 8: Release Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** blockterm can be published to npm as `blockterm` and installed with `npm i -g blockterm` on Windows, macOS and Linux; the release steps are written down. The publish itself is the owner's step.

**Architecture:** `package.json` gains the publish metadata and a `files` allowlist; `prepack` builds. A CI job packs the tarball and installs it globally on a clean runner per OS, then runs the installed binary. `docs/release.md` holds the manual release checklist.

**Tech Stack:** npm, GitHub Actions, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-17-blockterm-design.md` — §8 (npm, README, release doc), §10 item 8.

## Global Constraints

- Package name `blockterm`, bin `blockterm` → `dist/cli.js`, `engines.node` `>=24`, MIT. No new runtime dependencies.
- First version `0.1.0`.
- The tarball contains only `dist/`, `README.md`, `LICENSE`, `package.json` (no `src/`, `tests/`, `site/`, `deploy/`, `docs/`, `.superpowers/`).
- `npm publish` is never run by CI or by the agent (§8: owner's npm account with 2FA). Tag pushes (`v*`) run CI only.
- The site's install commands keep "build from source" until the package is actually on npm; `docs/release.md` has the step to switch them.

Ruling AK: node-pty 1.1.0 ships prebuilds for win32 and darwin only, so a Linux global install compiles it (needs python3, make, g++). Documented in the README; switching to a prebuilt fork is a dependency change that needs the owner's OK — cost: Linux users need build tools.

## Review Focus

1. The packed tarball runs from a global install in a folder with no repo checkout (no imports reaching outside `dist/`, no reads of `src/` or repo files at runtime) (Task 1 CI job).
2. `blockterm update` from a global npm install (no `.git` beside the package) runs `npm install -g blockterm@latest`, never `git pull` — already implemented in `src/update.ts` `detectInstall`; the pack-install CI job confirms the installed layout has no `.git` (Task 1).
3. `dist/cli.js` keeps its `#!/usr/bin/env node` line and is executable after install on macOS/Linux (Task 1 CI job runs `blockterm --version` by name).
4. Stale files in `dist/` from deleted sources don't ship (prepack cleans `dist/` before building) (Task 1).
5. `npm pack --dry-run` lists no test fixtures or secrets (Task 1 test of the file list).

---

### Task 1: Packaging and the clean-install CI job

**Files:**
- Modify: `package.json`, `.github/workflows/ci.yml`
- Create: `tests/package.test.ts`

**Interfaces:**
- Produces: `package.json` fields `version: "0.1.0"`, `description`, `keywords`, `homepage: "https://blockterm.mohamedazmi.dev"`, `bugs`, `files: ["dist"]` (README/LICENSE/package.json are always included), scripts `"clean": "node -e \"require('node:fs').rmSync('dist',{recursive:true,force:true})\""` and `"prepack": "npm run clean && npm run build"`.

- [ ] **Step 1: Write the failing tests:**
  - `tests/package.test.ts`: run `npm pack --dry-run --json` (via `fnm`-free `npm` from `process.env.npm_execpath` or `npm.cmd`/`npm` by platform) and assert every listed path is `package.json`, `README.md`, `LICENSE` or starts with `dist/`; `dist/cli.js` is listed; no path contains `test`, `.env`, `fixtures` or `.superpowers`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the package.json fields and scripts.
- [ ] **Step 4: CI job** `pack-install` in `.github/workflows/ci.yml`, matrix windows/macos/ubuntu, `needs: [test]`, Node 24: `npm ci`, `npm pack`, then in a fresh temp folder outside the checkout `npm i -g <path to tarball>`, then `blockterm --version` (expect `0.1.0`) and `blockterm --help` (expect the usage line). The ubuntu leg shows that compiling node-pty works with the runner's tools.
- [ ] **Step 5: Run** `npm test`, `npm run typecheck`, and locally `npm pack` + `npm i -g` into a temp prefix (`npm i -g --prefix <tmp>`) and run the installed `blockterm --version`.
- [ ] **Step 6: Commit** `build: npm packaging, clean-install CI job`

### Task 2: Release doc and README install

**Files:**
- Create: `docs/release.md`
- Modify: `README.md`, `docs/acceptance.md`

- [ ] **Step 1: Write `docs/release.md`:** numbered checklist — 1) on main, CI green (test + pack-install on all three OSes); 2) the owner runs the open acceptance items in `docs/acceptance.md`; 3) `npm version <patch|minor>` (creates the commit and the `v*` tag); 4) `git push --follow-tags`; 5) `npm publish` from the owner's account with 2FA (`npm publish --access public` the first time); 6) GitHub release from the tag with notes from the merged slices; 7) first release only: switch the site's install block and README "Install" to `npm i -g blockterm`, push to main (deploys the site); 8) verify `npm i -g blockterm` on a clean machine.
- [ ] **Step 2: README:** an "Install" section — Node 24 via fnm, nvm or the official installer; `npm i -g blockterm` (marked "after the first release; until then build from source"); Linux needs python3, make and g++ for node-pty (Ruling AK); `blockterm update` runs `npm install -g blockterm@latest` for npm installs. Keep "Build from source".
- [ ] **Step 3: acceptance.md:** "## Slice 8: release" — owner checks: `npm pack` tarball installs on a clean Windows/macOS/Linux machine, `blockterm doctor` passes after `blockterm setup`.
- [ ] **Step 4: Commit** `docs: release checklist and install instructions`
