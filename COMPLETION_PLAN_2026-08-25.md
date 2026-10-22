# Max — Completion Plan (native Mac self-host)
**Date:** 2026-08-25 · **Builds on:** `MAC_MIGRATION_SPEC_2026-07-28.md`, `HOSTING_RE-EVALUATION_2026-07-28.md`
**Decision (Suren, 2026-08-25):** self-host natively on the Mac. Railway retired, MBaaS retired.

---

## STATUS CORRECTION — Phase 1 is NOT done

`MAC_MIGRATION_SPEC` line: *"Join still fails from residential | Low | Already disproven — it worked on your Mac."*
That referred to `test-meet-local.js` (8 Jun), which is **navigation-only** — it never clicks join.

The real join test ran 28 Jul 17:02 (`test-meet-join.js`) and **failed**. Evidence on disk:

| Screenshot | What it proves |
|---|---|
| `prejoin-before-click.png` | Reached Meet's **full pre-join screen**. Name "Max" filled, camera denied, mic enumerated, button reads **"Join now"**. |
| `join-test-result.png` | After click: **"You can't join this video call" / "No one can join a meeting unless invited or admitted by the host."** |

### What this rules OUT (all previously suspected, all now cleared)
- ❌ Fingerprint / stealth detection — pre-join screen rendered normally
- ❌ Railway ASN / datacenter IP — this ran from residential and still failed
- ❌ Docker / container environment — this was native macOS
- ❌ Playwright automation tells — `--disable-blink-features`, webdriver override, evasion set all held

### What it points TO
Meeting **access policy**, matching `HOSTING_RE-EVALUATION` §3 cause #2 and Recall's documented
`google_meet_knocking_disabled` / `google_meet_sign_in_missing_login_credentials`.

Button read **"Join now"**, not "Ask to join" — Meet offered direct entry, then the server refused.
Most consistent with: **no host present in the room at 17:02**, and/or the room denies anonymous guests.

> Note: `setup-google-profile.js` was written 17:00, one minute before the failing test. The
> authenticated-profile path was **built but never tested.** That is exactly where work stopped.

---

## PHASE 1 — Settle the join (10 minutes, do this first)

Cheapest decisive test in the project. Two forks:

**1A — Host-present test (2 min).** Suren opens `https://meet.google.com/<test-room-code>` in his
normal browser and stays in it. Then run:
```
cd ~/Documents/Claude/max-bot
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 && unset NODE_ENV
node test-meet-join.js https://meet.google.com/<test-room-code> Max
```
- **Max appears in room or waiting room → Phase 1 DONE.** Root cause was host-absence. Nothing else to fix.
- **Still denied → 1B.**

**1B — Authenticated join (20 min).** Room policy blocks anonymous guests.
```
node setup-google-profile.js     # Suren signs in BY HAND. Claude never sees credentials.
node test-meet-join.js https://meet.google.com/<test-room-code> Max --profile
```
⚠️ Use a **dedicated throwaway Google account**, never the admin account (per the script's own header).

**Done when:** Max is visible in the TEST meeting participant list.

---

## PHASE 2 — Audio OUT on macOS (the only real engineering, ~half day)

`src/bot/audioInject.ts` (150 lines) spawns ffmpeg writing `f32le` → `-f pulse -device virtual_mic_input`.
PulseAudio does not exist on macOS. This file is the rewrite.

### Recommendation: spike Option D first (30 min), fall back to Option A

**Option D — in-page injection (no driver at all).** Override `navigator.mediaDevices.getUserMedia`
in `addInitScript` to return a `MediaStreamDestination` fed from the incoming PCM.

Why D over A:
- `audioCapture.ts` already proves in-page Web Audio works here (`window.AudioContext`, line 64).
  Same mechanism, opposite direction. Half of it is already written and battle-tested.
- No BlackHole, no ffmpeg subprocess, no CoreAudio device-index guessing.
- Deletes the entire `-device` bug class that cost 5 PRs in Milestone D v1.
- Kills the ffmpeg-death postmortem plumbing along with it.
- Fully cross-platform — a Linux host would work again for free.
- `addInitScript`-before-`page.goto` discipline is already established (Milestone C, PR #6).

**Option A fallback — ffmpeg `-f audiotoolbox` → BlackHole2ch.** Driver is already installed
(`/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver`). Closest to existing code. Unconfirmed risk:
output device-index selection.

**Done when:** a pre-recorded WAV pushed over `/ws_in/:bot_id` is audible to a human in the meeting.
*(Same acceptance test as Milestone D.)*

Also strip in this phase: `--use-pulseaudio` and `DISPLAY` from `joinMeet.ts` (~2 lines).

---

## PHASE 3 — Wire bot ↔ brain locally (~1 hr)

max-brain already runs: `.venv311/bin/python -m uvicorn max.server:app --host 127.0.0.1 --port 8080`
→ `/health` returns 200. Verified 2026-08-25.

1. **Fix the `.env`.** `Max AI Employee/.env` is dated 1 Apr and is missing `GEMINI_API_KEY`
   and `BOT_SERVICE_URL`. The `self-hosted` branch needs both — `/join` returns
   `{"error":"BOT_SERVICE_URL not set"}` without it. Restore the Jira vars too
   (`JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`) or **4 of Max's 6 tools fail
   silently at runtime, not at boot.** Source: `_railway_offline_backup_2026-07-06/railway-env-vars.env`.
2. Set `MAX_BRAIN_WS_URL=ws://localhost:8080/ws` — note `ws://`, not `wss://`.
3. Set `BOT_SERVICE_URL=http://localhost:8081` (max-bot's local port).

**Done when:** full conversation — you speak, Max hears, thinks, replies out loud.

---

## PHASE 4 — Survive unattended (~2 hrs)

- Two `launchd` plists with `KeepAlive`, auto-start at login (max-bot + max-brain)
- Disable sleep / App Nap (`caffeinate` or Energy Saver)
- Log rotation → `~/Library/Logs/max/`
- Free heartbeat monitor (healthchecks.io) alerting before standup if Max is down

**Done when:** reboot the Mac, both services return with no manual steps.

---

## PHASE 5 — Live verification (1 standup)

Real standup. Watch `/debug/timings`.
**Done when:** latency ≈ the Railway-era ~1.1 s baseline, no dropped turns.

---

## OPEN DECISIONS (not blockers)

1. **LLM.** `self-hosted` branch runs Gemini 2.5 Flash. The 28 Apr experiment documented real
   behavioural drift on Gemini — over-eager replies to non-Max chatter. That is the *same* failure
   Suren observed in smallest.ai's demo (2026-08-25) and the exact thing Max's persona was tuned to
   avoid. **Recommend reverting to Claude Haiku 4.5 for production** unless Gemini is re-tuned.
2. **`allow_interruptions`.** Still `False` (set 28 Apr to kill an acoustic feedback loop).
   Worth re-testing with headphones now — it is the axis every commercial voice product competes on.
3. **Branch hygiene.** `max-brain` `main` is the reverted MBaaS build; `self-hosted` is one commit
   ahead and is what actually runs. Merge or rename so `main` reflects reality.
4. **Project memory.** `Max AI Employee/memory/projects/max-ai-employee.md` stops at 28 Apr.
   It has no record of milestones A–F, the June anti-bot work, the Railway retirement, or the
   Mac migration. Four months stale — this is what made today's recovery necessary.

---

## EFFORT

| Phase | Estimate | Risk |
|---|---|---|
| 1 — join | 10 min – 20 min | Low |
| 2 — audio out | ~half day | **Only genuine unknown** |
| 3 — wire locally | ~1 hr | Low |
| 4 — launchd | ~2 hrs | Low |
| 5 — live standup | 1 standup | Low |

**Total: ~1 day of focused work.** Phase 2 is the only part that can surprise us.
