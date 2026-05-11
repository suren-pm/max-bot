# Max-Bot Notes (rolling)

> Living log of what we discovered about the existing meet-teams-bot codebase, decisions made, gotchas encountered.

---

## What's here from upstream meet-teams-bot

**Original purpose:** Serverless / job-style meeting bot. `main.ts` reads `MeetingParams` from STDIN, joins a meeting once, records audio + transcripts, uploads results, exits.

**Entrypoint:**
- `Dockerfile` has `ENTRYPOINT ["/start.sh"]`
- `/start.sh` is an embedded heredoc that:
  1. Boots `Xvfb` (virtual display, port :99)
  2. Boots `x11vnc` (debug VNC on port 5900, password `debug`)
  3. Boots `pulseaudio` + creates `virtual_speaker` (null sink) and `virtual_mic` (virtual source) PulseAudio devices
  4. Finally runs `node build/src/main.js` (one-shot)
- `main.ts` uses STDIN to receive params — NOT a long-running HTTP API

**Build target:** `build/` (output directory in `tsconfig.json` / `tsconfig.release.json`)

**Existing `src/server.ts` already exists** — it's a small Express control-plane that the recording session exposes during a meeting (routes: `POST /stop_record`, `GET /version`, `POST /upload`, `POST /play`). It is invoked from inside `main.ts`'s lifecycle, not as a top-level HTTP service.

**package.json scripts (existing):**
- `start` → `node build/src/main.js`
- `build` → writes `buildInfo.json` then `tsc --skipLibCheck -p tsconfig.release.json`
- `watch-dev` → `ts-node-dev` for local dev
- `test` → `jest`
- (plus format, dead-code checks)

**Key dependencies (existing):**
- Playwright + Chromium (for browser automation)
- AWS SDK (S3 uploads)
- Express (already in deps, used by `src/server.ts`)
- TypeScript, ts-jest, jest

**Node version (existing constraint):**
- `package.json` `engines.node`: `>= 18.0.0 <=20`
- `.npmrc` sets `engine-strict=true` — so npm refuses to install on Node >20
- Local dev: `nvm use 20`
- Container: Node 20.x (installed via NodeSource in the Dockerfile)

**Jest config (existing):**
- Preset: `ts-jest`
- testMatch: `**/src/**/*.test.ts`
- Setup file: `jest.setup.ts` — mocks `src/browser/browser` so tests don't need a real Chromium

---

## What we're adding in Milestone A

- `src/app.ts` — NEW Express HTTP server with `/health` endpoint. This is the top-level long-running service entrypoint for the self-hosted bot (will later own `/join`, `/leave`, `/ws/{bot_id}`).
- `src/app.test.ts` — Jest + supertest test for `/health`
- New npm script `start:server` → `node build/src/app.js` (preserves the existing `start` script that runs the original `main.js`)
- New Dockerfile `EXPOSE 8080` + appended `ENTRYPOINT ["node", "build/src/app.js"]` at the end (last ENTRYPOINT wins, so this overrides `/start.sh`)
- `railway.toml` — Railway-specific build config + `/health` healthcheck

---

## Decisions we made

- **Use `src/app.ts`, not `src/server.ts`** — `src/server.ts` already exists upstream and serves a different purpose (in-meeting control plane). To avoid clobbering it, the new top-level HTTP server lives in `src/app.ts` (Express convention for app entrypoint).
- **Use `build/` not `dist/`** — match the existing `tsconfig` convention. Original plan called for `dist/` but the repo already uses `build/`. Less churn.
- **Override `ENTRYPOINT` rather than rewriting the Dockerfile** — append a new `ENTRYPOINT ["node", "build/src/app.js"]` at the end of the Dockerfile. The last ENTRYPOINT wins, so the original `/start.sh` (with all the Xvfb + PulseAudio setup) stays in the image for resurrection in Milestone B when we actually need Chromium + audio.
- **Add `start:server` script, don't replace `start`** — preserve upstream behaviour. `start` still runs the legacy `main.js` recording flow. `start:server` runs the new HTTP server.
- **Use Node 20 locally** — `.npmrc` enforces engine-strict. `nvm use 20` before any `npm` command.

---

## Gotchas discovered

- **`.npmrc` has `engine-strict=true`** — npm install fails on Node 24 (my default). Must `nvm use 20` first. If we want to relax this later, edit `.npmrc` — but it's not necessary, Node 20 is fine.
- **No existing `dist/` directory or `start` script pointing at server-only code** — every build artifact goes to `build/src/...`. Path is `build/src/app.js` not `build/app.js`.
- **`src/server.ts` namespace collision** — almost wrote our new server over the existing one. Caught it by listing `src/` before creating any file. Lesson: always grep for filename conflicts before creating.
- **Existing `/start.sh` runs `main.js` at the end of a long boot** — the Dockerfile bakes a heredoc that ends with `node build/src/main.js`. If we wanted Xvfb + PulseAudio for Milestone A we'd need to modify the embedded script. We're skipping that — `/health` doesn't need a display or audio. Milestone B will revisit.
- **EXPOSE 5900 is set (VNC), but no web port** — added `EXPOSE 8080` for Railway.
- **`NODE_ENV=production` in the shell breaks `npm ci` for dev deps** — Suren's shell exports `NODE_ENV=production` at startup. With that set, `npm ci` (even with the lockfile) silently skips devDependencies. Fix: `unset NODE_ENV` before any local install, or use `npm ci --include=dev`. Inside the Dockerfile, `NODE_ENV=production` is set AFTER `RUN npm ci`, so the container build is unaffected.
- **`jest` is not declared in `package.json`** — upstream lists `ts-jest`, `@types/jest`, `@types/supertest`, `supertest` but NOT `jest` itself. `jest` is pulled in transitively as ts-jest's peer dep. Tests run fine; no fix needed.
- **`@babel/code-frame@^7.29.0` resolution error when wiping `package-lock.json`** — fresh resolution from package.json tries to pull a non-existent babel version (highest published 7.x is 7.28.6). Don't `rm -rf node_modules package-lock.json && npm install` — use `npm ci --include=dev` from the committed lockfile instead.
- **Railway didn't auto-generate a public domain** — the service deployed successfully and reported "Online" status, but the public URL stayed 404 ("Application not found") because no domain was generated. Manually clicked Settings → Networking → Generate Domain. Resulting URL: `max-bot-production-7455.up.railway.app`. There's an earlier `1.up.railway.app` numeric suffix in Railway's auto-generation algorithm — the final URL is NOT `max-bot-production.up.railway.app` as I'd guessed.
- **Railway CLI requires `railway login` (browser flow)** — non-interactive automation against the dashboard via CLI is blocked without a one-time auth. I used the browser instead.

---

## Milestone A — completed 2026-05-11

- Service deploys cleanly on Railway from the `main` branch via PR #1 merge
- Acceptance criterion met: `GET https://max-bot-production-7455.up.railway.app/health` returns `200 {"status":"ok","service":"max-bot","version":"0.1.0"}`
- Existing recording-bot code (`src/main.ts`, `src/server.ts`, `/start.sh` heredoc) is untouched — Milestone B can resurrect it
- Time spent: ~1 hour, mostly debugging the `NODE_ENV=production` shell-level npm install issue
- Decisions made during the milestone (also see "Decisions we made" above):
  - Renamed our entrypoint from `src/server.ts` (planned) to `src/app.ts` (actual) to dodge the existing `src/server.ts`
  - Compiled to `build/` not `dist/` to match upstream `tsconfig`
  - Appended a new `ENTRYPOINT` rather than rewriting `/start.sh` — Docker's last-ENTRYPOINT-wins rule does the override cleanly
  - Skipped local Docker build (Ubuntu+Playwright+AWS-CLI is ~10 min) and used Railway as the build-verification step
- Open items / parked for Milestone B:
  - The legacy `/start.sh` heredoc still runs `node build/src/main.js` at its end — when we resurrect it for Milestone B we'll need to change that line to `node build/src/app.js` and have app.ts orchestrate Playwright from inside the long-running service
  - Volta config in `package.json` says `"node": "20.18.0"` — we're on 20.20.0 locally. Mild drift, no impact

Ready for Milestone B: Playwright join flow.

---

## Milestone B — POST /join + Playwright waiting-room flow

### What's added (so far on `milestone-b/playwright-join` branch)

- `src/bot/joinMeet.ts` — self-contained Playwright + Google Meet driver. Inspired by upstream `src/meeting/meet.ts` selectors but independent of GLOBAL singleton / state machine.
- `src/bot/sessions.ts` — in-memory `Map<bot_id, JoinSession>` registry.
- `src/app.ts` — added `POST /join`, `POST /leave/:bot_id` routes alongside the existing `/health`.
- `Dockerfile` — reverted Milestone-A `ENTRYPOINT ["node", "build/src/app.js"]` override. Single `ENTRYPOINT ["/start.sh"]` remains, with its heredoc edited so the final `exec` is `node build/src/app.js` (was `node build/src/main.js` upstream).

### Decisions made during the milestone

- **Minimal reimplementation, not reuse, of upstream Meet logic.** `src/meeting/meet.ts`'s `MeetProvider` is tightly coupled to `GLOBAL` singleton and the recording state machine. Reusing it would pull in nearly the whole upstream framework. `src/bot/joinMeet.ts` copies the DOM selectors with `// References:` comments pointing back at the source-line numbers.
- **In-process Playwright, not child-process.** Spawning `node build/src/main.js` per join would collide with its internal port-8080 `server()` and assumes single-shot lifecycle. In-process is simpler.
- **Single bot at a time.** `POST /join` returns 409 if `hasActiveSession()` is true. v1 scope.
- **Restored `/start.sh`** as the Docker entrypoint so Xvfb is up before Playwright launches.

### Gotchas

- **`@types/node` is pinned at 14.x by upstream**, so `crypto.randomUUID` (Node 16+) is missing from the type declarations. Cast around it: `(crypto as unknown as { randomUUID: () => string }).randomUUID`. At runtime, Node 20 has the function.
- **Upstream has ~18 broken Jest tests in `src/urlParser/`** (pre-existing on `main`). Confirmed they fail on `main` before my changes too. Not caused by Milestone B; not in scope to fix here.
- **`/start.sh` boot takes ~10–20 seconds** before `app.ts` is ready (Xvfb + PulseAudio + sanity check + node). Railway's healthcheckTimeout in `railway.toml` is 60s — should be fine, but if the deploy reports healthcheck failure, bump it to 120s and re-PR.


