# blockterm Landing Page + Deploy Implementation Plan

> **For agentic workers:** executed natively by the controller (small plan, one final review).

**Goal:** `https://blockterm.mohamedazmi.dev` serves a one-page site from this repo, redeployed on every push to `main`.

**Architecture:** Static `site/index.html` (inline CSS, no build) served by a `caddy:2-alpine` container `blockterm-site` on the VPS's external Docker network `edge`. The shared edge Caddy terminates TLS. A CI `deploy` job SSHes to the VPS, fast-forwards the clone and runs `docker compose up -d --build --wait`.

**Spec:** `docs/superpowers/specs/2026-10-17-blockterm-design.md` §8 (landing page + deploy, decided 2026-10-18).

## Global Constraints

- No build step, no JS framework. Fonts only from Google Fonts. Works at 360px width, keyboard focus visible, `prefers-reduced-motion` respected.
- Copy is honest: blockterm is not on npm yet. Show install from source, and mark `npm i -g blockterm` as coming with v0.1.
- Container name `blockterm-site`, internal port 80, no host ports, networks `default` + external `edge`.
- Deploy job: only on push to `main`, after the test matrix, environment `staging`. Secrets `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`. Host key pinned from the secret, never `ssh-keyscan`. `git merge --ff-only`.

### Task 1: Site container

**Files:** Create `deploy/Caddyfile`, `deploy/site.Dockerfile`, `deploy/docker-compose.prod.yml`, `.dockerignore`

- [ ] `deploy/Caddyfile`: `:80 { encode zstd gzip; root * /srv/site; file_server }`, plus security headers (`X-Content-Type-Options nosniff`, `Referrer-Policy strict-origin-when-cross-origin`).
- [ ] `deploy/site.Dockerfile`: `FROM caddy:2-alpine`, copy the Caddyfile and `site/`.
- [ ] Compose project `blockterm`, service `site`, `container_name: blockterm-site`, `restart: unless-stopped`, healthcheck `wget -q -O /dev/null http://127.0.0.1:80/`.
- [ ] Verify locally: `docker build -f deploy/site.Dockerfile .`, then run it on a host port and `curl` → 200 with the page title.

### Task 2: Landing page

**Files:** Create `site/index.html`

- [ ] Hero: `#` prompt headline + blockterm mock (ssh session block + agent panel with approval card). One load sequence.
- [ ] Install: tabs or sections for Windows / macOS / Linux, each with copy buttons. Node 24 prerequisite.
- [ ] What it does: blocks, agent in ssh/vim with approval, bring your own model (the three AI SDK packages), keys from env vars.
- [ ] Footer: GitHub link, MIT.
- [ ] Verify: screenshot at desktop and 375px widths; no horizontal scroll.

### Task 3: Deploy job

**Files:** Modify `.github/workflows/ci.yml`

- [ ] Add a `deploy` job (`needs: test`, `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, `environment: staging`), copying the SSH + known_hosts check from the owner's carrier-operations-platform workflow. Remote script: `cd "$DIR"`, `git fetch --prune origin`, `git merge --ff-only origin/main`, `docker compose -f deploy/docker-compose.prod.yml up -d --build --wait`, `docker image prune -f`.
- [ ] README: one line linking the site.
