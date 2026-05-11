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

---
