# Max — Native Mac Migration: Full Comparative Spec & Plan
**Date:** 2026-07-28 · **Supersedes:** Railway hosting · **Companion doc:** `HOSTING_RE-EVALUATION_2026-07-28.md`

All sizes below are **measured** unless marked *(est.)*.

---

# PART 1 — WHAT WAS ON RAILWAY (the current/old spec)

## 1.1 Infrastructure

| Item | Value |
|---|---|
| Platform | Railway, Hobby plan ($5/mo) — **ends Jul 29, 2026** |
| Projects | `max-self-hosted` (max-bot + max-brain), `sincere-grace` (production max-brain, speaking-meeting-bot) |
| max-bot region | Singapore (`asia-southeast1`), 1 replica |
| max-brain region | EU West, 1 replica |
| Build | `railway.toml` → `builder = "DOCKERFILE"`, healthcheck `/health`, restart ON_FAILURE ×5 |
| Deploy trigger | Auto-deploy on push to GitHub |
| Egress IP | AS400940 (Railway) — **blocked by Google Meet** |

## 1.2 The max-bot Docker image (contents & est. size)

Base `ubuntu:24.04`, built from the repo `Dockerfile`:

| Layer / package | Purpose | Size *(est.)* |
|---|---|---|
| `ubuntu:24.04` | Base OS | ~78 MB |
| Node.js 20.x | Runtime | ~200 MB |
| `libnss3`, `libatk-bridge2.0-0`, `libdrm2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxrandr2`, `libgbm1`, `libxss1`, `libxshmfence1` | Chromium's Linux deps | ~150 MB |
| `xvfb` | **Fake screen** (no monitor in a container) | ~80 MB |
| `x11vnc`, `x11-utils` | Remote-view the fake screen to debug | ~50 MB |
| `unclutter` | Hide mouse cursor on fake screen | ~1 MB |
| `pulseaudio`, `pulseaudio-utils` | **Fake sound card** | ~50 MB |
| `ffmpeg` | Audio format conversion | ~250 MB |
| `curl`, `wget`, `unzip`, `gnupg`, `ca-certificates` | Build utilities | ~30 MB |
| **AWS CLI v2** | S3 upload — **never used by Max** | ~250 MB |
| `node_modules` (npm ci) | App deps | **47 MB** |
| Playwright Chromium | The actual browser | ~450 MB *(est.)* |
| Built TypeScript app | Our code | ~5 MB |
| **TOTAL IMAGE** | | **~1.6 GB** *(est.)* |

## 1.3 The `/start.sh` boot sequence (Linux-only scaffolding)

1. Start `Xvfb :99` at 1280×860 — a screen that doesn't exist
2. `unclutter` — hide the cursor
3. `x11vnc` on port 5900 (password `debug`) — so a human can watch
4. Start PulseAudio daemon (`--daemonize=yes --exit-idle-time=-1`)
5. Create `virtual_speaker` null-sink (meeting audio lands here)
6. Create `virtual_mic_input` null-sink + `virtual_mic` virtual-source with `master=virtual_mic_input.monitor` — **the two-sink fix from Milestone D that stopped the echo loopback**
7. Set defaults, tune resample method, verify `virtual_speaker.monitor` exists
8. `node build/src/app.js`

## 1.4 Runtime config

- `DISPLAY=:99`, `PULSE_RUNTIME_PATH=/tmp/pulse`, `XDG_RUNTIME_DIR=/tmp/pulse`
- `NODE_OPTIONS=--max-old-space-size=2048`, `SERVERLESS=true`, `NODE_ENV=production`
- Ports: 8080 (HTTP API), 5900 (VNC)
- Env var: `MAX_BRAIN_WS_URL=wss://max-brain-production-2842.up.railway.app/ws`

---

# PART 2 — SIDE-BY-SIDE: BEFORE vs AFTER

## 2.1 Infrastructure & platform

| Component | Railway (before) | Native Mac (after) | Verdict |
|---|---|---|---|
| Host | Railway container, Singapore | Your Mac, home network | **REPLACED** |
| Egress IP | AS400940 datacenter — blocked | Residential — **proven to work** | **REPLACED** |
| Cost | $5/mo | $0/mo | **ELIMINATED** |
| Container runtime | Docker | none — runs natively | **ELIMINATED** |
| Base OS | ubuntu:24.04 | macOS (already there) | **ELIMINATED** |
| Deploy | git push → auto-build | `git pull` + restart | **REPLACED** |
| Process manager | Railway restart policy | macOS `launchd` | **REPLACED** |
| Config | Railway env vars | `.env` file | **REPLACED** |

## 2.2 Display stack — all of it disappears

| Component | Railway | Mac | Verdict |
|---|---|---|---|
| Virtual display | `Xvfb :99` @1280×860 | Real macOS display | **DELETED** |
| Cursor hiding | `unclutter` | not needed | **DELETED** |
| Remote debug view | `x11vnc` :5900 | Just look at the window | **DELETED** |
| X11 utils | `x11-utils` | not needed | **DELETED** |
| `DISPLAY` env var | `:99` | not needed | **DELETED** |
| Chromium Linux libs | 10 `lib*` packages | macOS ships its own | **DELETED** |

## 2.3 Audio stack — the only genuinely tricky part

| Direction | Railway | Mac | Verdict |
|---|---|---|---|
| **IN** (meeting → Max) | `audioCapture.ts` — Web Audio API **inside the browser page** (`new AudioContext()`) | **Identical** | ✅ **ZERO CHANGE** |
| **OUT** (Max → meeting) | `audioInject.ts` — ffmpeg `-f pulse -device virtual_mic_input` | Needs macOS equivalent | ⚠️ **THE ONE REAL CHANGE** |
| Virtual sound card | PulseAudio + 2 null-sinks + virtual-source | BlackHole (or in-page injection) | **REPLACED** |
| Echo-loopback fix | `master=virtual_mic_input.monitor` two-sink trick | Not needed — capture is in-page | **SIMPLER** |
| Audio format | 16 kHz mono, f32le → PCM | Identical | ✅ **NO CHANGE** |

> **Key discovery:** inbound capture is pure JavaScript running *inside Chrome* (`audioCapture.ts` line 64 uses `window.AudioContext`). It never touched PulseAudio. **Half the audio problem is already cross-platform.**

## 2.4 Application code

| File | Railway | Mac | Verdict |
|---|---|---|---|
| `joinMeet.ts` | stealth config @ `36b535e` | same, **minus 2 lines** (`--use-pulseaudio`, `DISPLAY`) | **~2 line change** |
| `audioCapture.ts` | Web Audio in-page | identical | ✅ none |
| `audioInject.ts` | ffmpeg → PulseAudio | ffmpeg/node → BlackHole | ⚠️ **rewrite (~1 file)** |
| `audioStream.ts`, `wsServer.ts`, `maxBrainBridge.ts`, `sessions.ts`, `app.ts` (+ all `/diag`) | — | identical | ✅ none |
| `Dockerfile`, `/start.sh`, `railway.toml` | required | **deleted** | **DELETED** |
| `ScreenRecorder.ts`, `S3Uploader.ts`, `uploadTranscripts.ts` | present, unused | can delete | **DEAD CODE** |
| `@aws-sdk/client-s3`, `client-sqs`, `lib-storage` | installed | remove | **DELETED** |
| AWS CLI v2 (~250 MB) | installed | not installed | **DELETED** |

## 2.5 max-brain (the Pipecat brain) — unchanged

| Component | Railway | Mac | Verdict |
|---|---|---|---|
| Pipecat 0.0.108 pipeline | ✔ | identical | ✅ none |
| Silero VAD → Deepgram STT → LLM → SilenceTextFilter → Deepgram TTS | ✔ | identical | ✅ none |
| 6 Jira/task tools, persona, `/debug/timings` | ✔ | identical | ✅ none |
| WebSocket protocol (raw PCM 16 kHz) | ✔ | identical | ✅ none |
| LLM | Gemini 2.5 Flash (self-hosted branch) | your choice | optional |
| Where it runs | Railway EU West | same Mac, `localhost` | **REPLACED** |
| Bot↔brain hop | public internet WSS | **localhost — faster** | **IMPROVED** |

---

# PART 3 — FINAL DISK FOOTPRINT

| Item | Size | Source |
|---|---|---|
| `max-bot` source + `.git` | **23 MB** | measured (11 MB git + 2 MB src + rest) |
| `max-bot/node_modules` | **47 MB** | measured (~5 MB less after dropping AWS SDK) |
| Playwright Chromium (macOS) | ~450 MB | *(est.)* |
| `max-brain` code + `.git` | **7 MB** | measured |
| `max-brain` Python venv — **clean install** | ~250 MB | *(est.)* — only `requirements-server.txt` |
| BlackHole audio driver | ~2 MB | *(est.)* — small driver (**I over-stated 50 MB earlier; correcting**) |
| ffmpeg (Homebrew, if needed) | ~150 MB | *(est.)* |
| **TOTAL** | **≈ 930 MB** | **call it 1 GB** |

### Space you get *back*
Your existing `venv` is **737 MB**, but it's carrying dead weight from abandoned phases:
`llvmlite` 113 MB · `scipy` 100 MB · `transformers` 95 MB · `sympy` 79 MB · `onnxruntime` 68 MB · `numba` 31 MB · `daily` 28 MB · `PIL` 15 MB · `openai` 14 MB · `nltk` 14 MB
Only `pipecat`, `onnxruntime` (Silero VAD), `numpy`, `fastapi`, `uvicorn`, `httpx`, `protobuf`, `loguru` are in `requirements-server.txt`.
**Rebuilding clean reclaims ~490 MB.**

### Comparison
| | Size |
|---|---|
| Railway Docker image *(est.)* | ~1.6 GB (on Railway, never your Mac) |
| **Native Mac total** | **~1 GB** |
| If you used Docker Desktop on Mac instead | ~5–6 GB |

### The real constraint is RAM, not disk
Chromium in a live call: **1–2 GB RAM** sustained. Node capped at 2 GB. Python/Pipecat ~500 MB.
**Budget ~3–4 GB RAM while a standup is running.** Fine on any modern Mac.

---

# PART 4 — MIGRATION PLAN

### Phase 0 — Prerequisites (~30 min)
- Node 20 (`volta`/`nvm` — package.json pins `>=18 <=20`)
- Python 3.11
- `brew install ffmpeg`
- Install **BlackHole 2ch** (free, ExistentialAudio)
- `npm ci` + `npx playwright install chromium`
- Fresh venv from `requirements-server.txt` only (**do not** reuse the 737 MB one)
- **Done when:** `npm run build` succeeds and `uvicorn max.server:app` serves `/health`

### Phase 1 — Prove the join, natively (~1 hr) ⬅ *the decisive test*
- Run `test-meet-local.js` against the TEST meeting (`meet.google.com/<test-room-code>`)
- Then run the real `app.ts` + `POST /join` on macOS, no Docker
- **Done when:** Max appears in the waiting room / call from the Mac
- **This also settles the old ASN question for good.** If it joins here but the Docker-on-Mac variant fails, the cause was container fingerprint, never Railway's IP.

### Phase 2 — Audio OUT via BlackHole (~half day) ⬅ *the only real engineering*
Rewrite `audioInject.ts`. **Timebox a 30-min spike to pick the approach — this is the one unverified piece:**

| Option | Approach | Trade-off |
|---|---|---|
| **A** | ffmpeg `-f audiotoolbox` → BlackHole device index | Closest to current code; **device-index selection for *output* is unconfirmed** |
| **B** | `node-speaker` npm → CoreAudio directly | Drops the ffmpeg subprocess; pure Node |
| **C** | Set BlackHole as system default output, ffmpeg writes to default | Simplest; hijacks the Mac's audio |
| **D** | **In-page injection** — `AudioContext` + `MediaStreamDestination`, override `getUserMedia` in `addInitScript` | Most elegant, fully cross-platform, no BlackHole at all; unproven in our codebase |

Then point Chrome's mic at BlackHole (`--use-fake-ui-for-media-stream` already auto-grants permission).
- **Done when:** a pre-recorded WAV pushed over the WebSocket is audible to a human in the meeting *(same acceptance test as Milestone D)*

### Phase 3 — Wire bot ↔ brain locally (~1 hr)
- Run max-brain on `localhost:8080`
- Set `MAX_BRAIN_WS_URL=ws://localhost:8080/ws` (note: `ws://` not `wss://`)
- **Done when:** full conversation — you speak, Max hears, thinks, replies out loud

### Phase 4 — Make it survive unattended (~2 hrs)
- Two `launchd` plists (`KeepAlive`) — max-bot + max-brain, auto-start at login
- Disable App Nap / sleep (`caffeinate` or Energy Saver)
- Log rotation to `~/Library/Logs/max/`
- Free heartbeat monitor (healthchecks.io) → alert if Max is down before standup
- **Done when:** reboot the Mac, both services come back with no manual steps

### Phase 5 — Live verification (1 standup)
- Real standup, watch `/debug/timings`
- **Done when:** latency ≈ the Railway-era ~1.1 s baseline, no dropped turns

**Total: ~1.5–2 days.** Phase 2 is the only part with genuine unknowns.

---

# PART 5 — RISKS

| Risk | Severity | Mitigation |
|---|---|---|
| macOS audio-out approach doesn't work as expected | **Med-High** | 4 fallback options above; Option D needs no OS driver at all |
| Mac asleep / offline at 7:15 am | Med | Disable sleep, UPS, heartbeat alert |
| Home internet outage | Low-Med | ~2–5 outages/yr on fiber; phone hotspot fallback |
| macOS mic permission prompt blocks Chrome | Med | Grant Terminal/node mic access in System Settings once |
| Google changes Meet's UI, breaks selectors | Ongoing | Unchanged from before — same risk on any self-host |
| Join still fails from residential | **Low** | Already disproven — it worked on your Mac |

---

# PART 6 — WHAT TO DELETE AFTERWARDS

Once Phase 5 passes:
- `Dockerfile`, `/start.sh` heredoc, `railway.toml`
- AWS SDK deps + `S3Uploader.ts`, `uploadTranscripts.ts`, `ScreenRecorder.ts`
- The bloated 737 MB `venv`
- Railway projects (already paused; auto-removed after Jul 29)

**Keep:** `_railway_offline_backup_2026-07-06/` (bundles + env vars) until Max runs clean for two weeks.

---

## Note on licence
`package.json` declares **Apache-2.0**, while the April design doc recorded upstream `meet-teams-bot` as **Elastic License 2.0**. Either way internal self-hosting is permitted — but if this ever becomes commercially relevant, verify the upstream `LICENSE` file rather than trusting the `package.json` field.

## Sources
[BlackHole (ExistentialAudio)](https://github.com/ExistentialAudio/BlackHole) · [BlackHole + ffmpeg issue #45](https://github.com/ExistentialAudio/BlackHole/issues/45) · [Chrome WebRTC IP handling](https://chromeenterprise.google/policies/web-rtc-ip-handling/) · [puppeteer-extra #907 (the stealth fix already in our code)](https://github.com/berstend/puppeteer-extra/discussions/907)
