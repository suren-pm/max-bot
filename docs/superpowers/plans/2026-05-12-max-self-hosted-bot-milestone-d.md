# Max Self-Hosted Bot — Milestone D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A WebSocket client connecting to `wss://max-bot-production-7455.up.railway.app/ws_in/:bot_id` and writing raw 16 kHz mono Int16 PCM frames causes those frames to be played as Max's microphone in the Google Meet — every participant hears them, indistinguishable from a human speaking.

**Architecture:** Following the proven upstream pattern (`src/streaming.ts:560-607` + `src/media_context.ts:145-166`). Per-bot, we spawn one `ffmpeg` subprocess that consumes raw Float32 audio from stdin and writes to ALSA's PulseAudio plugin (`pulse:virtual_mic`). The virtual mic source was already declared in `/start.sh` (`pactl load-module module-virtual-source source_name=virtual_mic`). Chrome's `getUserMedia` (configured via `--use-fake-ui-for-media-stream`) auto-grants the bot's outgoing mic stream and uses the PulseAudio default source, which we set to `virtual_mic`. Bytes arriving on `/ws_in/:bot_id` get converted Int16→Float32 and piped to that ffmpeg's stdin.

**The hardest milestone (per the original design spec).** The Phase 1 spec calls this out: "Chrome's `getUserMedia` + PulseAudio routing in Docker is notoriously finicky." Our `/diag` confirms PulseAudio refuses to start in the container — that's the very first blocker.

**Tech Stack:** TypeScript, Node 20, `ffmpeg` (already installed by upstream Dockerfile), PulseAudio (broken — Task D.2 fixes), Playwright Chromium with `--use-fake-ui-for-media-stream`, `ws` package.

**Pre-conditions in place:**
- Milestone C is shipped (commit `e7d4d18` on `main`). Capture stream works.
- `wss://max-bot-production-7455.up.railway.app/ws/:bot_id` streams 16 kHz mono Int16 PCM out.
- Upstream `/start.sh` heredoc already creates `virtual_mic` virtual source IF PulseAudio runs — but `/diag` shows PulseAudio dead with `Connection refused`.
- Live URL is `https://max-bot-production-7455.up.railway.app/`.

**Pre-conditions NOT in place (must fix in this milestone):**
- **PulseAudio not running.** Surfaces as `pulse_info: Connection failure: Connection refused` in `/diag`. Root cause unknown — first task is diagnosing.
- **Default PulseAudio source not set to `virtual_mic`.** Upstream `/start.sh` sets `pactl set-default-sink virtual_speaker` but never sets the default SOURCE. Chrome's mic input goes to whatever PulseAudio says is the default source — need that to be `virtual_mic`.
- **Chrome mic permission flow.** We pass `--use-fake-ui-for-media-stream` which auto-grants permission, but we also need the right mic device selected.

**What ships at end of Milestone D:**
- `wss://.../ws_in/:bot_id` accepts binary frames of 16 kHz mono Int16 PCM
- Those frames are heard by every participant in the Meet as Max's voice
- `/diag` shows `pulse_info` reporting `Server String: ...` (no Connection refused) and `pulse_sources` listing `virtual_mic` and `virtual_speaker.monitor`
- New `scripts/play-audio-to-bot.js` test client streams a WAV file into the bot
- `GET /diag/inject/:bot_id` reports ffmpeg-subprocess state for ops debugging

**Out of scope for Milestone D (deferred to E/F):**
- max-brain integration (E)
- Multi-bot
- Echo / barge-in handling
- Voice activity detection on the injection side

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `src/bot/audioInject.ts` | Create | Spawns `ffmpeg -f f32le -ar 16000 -ac 1 -i - -f alsa pulse:virtual_mic` per session. Exposes `pushInt16Buffer(buf)` that converts to Float32 and writes to stdin. |
| `src/bot/audioInject.test.ts` | Create | Tests: spawn args correct, Int16→Float32 conversion correct, pushInt16Buffer writes to stdin, stop() kills subprocess, errors surfaced. ffmpeg subprocess mocked via `child_process` mock. |
| `src/bot/wsServer.ts` | Modify | Add `/ws_in/:bot_id` handler alongside the existing `/ws/:bot_id`. New endpoint routes binary frames to `session.audioInject.pushInt16Buffer(buf)`. |
| `src/bot/wsServer.test.ts` | Modify | Add cases for `/ws_in/:bot_id` accept, unknown bot_id rejection, forwarded bytes hit audioInject. |
| `src/bot/sessions.ts` | Modify | Add `audioInject: AudioInject` field to `JoinSession`. |
| `src/bot/sessions.test.ts` | Modify | Update stub sessions with `audioInject`. |
| `src/app.ts` | Modify | `/join` creates AudioInject + wires it into session. `/leave` stops it. `/diag/inject/:bot_id` new endpoint reports the subprocess state. `/diag` extended with `pulse_default_source`. |
| `src/app.test.ts` | Modify | Mocks for new AudioInject construction inside /join. |
| `Dockerfile` | Modify | `/start.sh` heredoc fixed so PulseAudio actually runs. Likely: drop `--start`, run with explicit config, ensure dbus / runtime dir, set default source to virtual_mic. |
| `scripts/play-audio-to-bot.js` | Create | Test client: reads a WAV file, opens WS to `/ws_in/:bot_id`, streams 100ms binary Int16 chunks at real-time pace. |
| `docs/CLAUDE-NOTES.md` | Modify | Append Milestone D decisions + gotchas. |

**Files we deliberately do NOT touch:**
- `src/main.ts`, `src/server.ts`, `src/streaming.ts`, `src/media_context.ts`, `src/meeting/`, `src/state-machine/` — upstream stays untouched as before. We reuse the *patterns* without imports.

---

## Decisions locked in for Milestone D

- **Per-bot ffmpeg subprocess, not in-process audio synthesis.** Upstream does this and it works — `ffmpeg -f f32le -i - -f alsa pulse:virtual_mic`. Cheap, reliable, exits cleanly on stdin EOF.
- **Default source = `virtual_mic`.** Set in `/start.sh` after `pactl load-module module-virtual-source`. Chrome's `getUserMedia` will then receive virtual_mic's stream when Meet asks for the bot's mic.
- **`/ws_in/:bot_id` is one-way write.** No bytes back. Single-listener-style: second concurrent connection rejected with code 1008 (matches `/ws/` design).
- **PulseAudio fix is part of this milestone.** Without it the rest doesn't work. The plan front-loads the fix (D.2) before any TDD on the new modules.
- **Diagnostic endpoint pattern again.** `GET /diag/inject/:bot_id` reports ffmpeg process state. Lessons from Milestone C — bake it in early.

---

## Pre-work — branch setup

### Task D.0: Branch from `main`

**Files:** None modified.

- [ ] **Step 1: Pull + branch**

```bash
cd ~/Documents/Claude/max-bot
git checkout main
git pull origin main
git checkout -b milestone-d/audio-inject
```

- [ ] **Step 2: Verify Node 20 + jest binary + baseline tests pass**

```bash
unset NODE_ENV && source ~/.nvm/nvm.sh && nvm use 20
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | tail -8
```

Expected: 29/29 tests pass.

---

## Task D.1: Add `/diag/pulse` deep-diagnostic endpoint

**Files:**
- Modify: `src/app.ts` — extend `/diag` payload OR add a new `/diag/pulse` route

`/diag` already reports `pulse_info` and `pulse_sources`, but those just show "Connection refused" today. We need MORE info to know WHY PulseAudio refuses to start. Add a `/diag/pulse` endpoint that runs a battery of checks:

- [ ] **Step 1: Add the endpoint in `src/app.ts` (right next to existing `/diag`)**

```typescript
app.get('/diag/pulse', (_req: Request, res: Response) => {
    const tryExec = (cmd: string): string => {
        try {
            return execSync(cmd, {
                timeout: 3000,
                stdio: ['ignore', 'pipe', 'pipe'],
            }).toString().trim()
        } catch (e) {
            return `ERROR: ${e instanceof Error ? e.message : String(e)}`
        }
    }
    res.status(200).json({
        env: {
            PULSE_RUNTIME_PATH: process.env.PULSE_RUNTIME_PATH ?? null,
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? null,
            DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
        },
        pulse_processes: tryExec('pgrep -a pulseaudio || echo NONE'),
        runtime_dir_listing: tryExec('ls -la /tmp/pulse 2>&1 || echo MISSING'),
        runtime_dir_perms: tryExec('stat -c "%U:%G %a %n" /tmp/pulse 2>&1'),
        dbus_socket: tryExec('ls -la /run/dbus/system_bus_socket 2>&1 || echo MISSING'),
        pulse_log_tail: tryExec(
            'find /tmp /root -name "pulse*.log" 2>/dev/null | xargs tail -20 2>&1 || echo NONE',
        ),
        try_pactl_info: tryExec('pactl info 2>&1 | head -10'),
        try_start_pulse: tryExec(
            'pulseaudio --check; echo "exitcode=$?"',
        ),
        machine_id: tryExec('cat /etc/machine-id 2>&1'),
    })
})
```

- [ ] **Step 2: Commit + push + deploy**

```bash
git add src/app.ts
git commit -m "diag: /diag/pulse endpoint for deep PulseAudio diagnostics"
git push -u origin milestone-d/audio-inject
gh pr create --base main --head milestone-d/audio-inject --title "D.1: /diag/pulse endpoint" --body "Deep diagnostics for the broken PulseAudio in our container."
gh pr merge --merge --delete-branch
git checkout main && git pull --rebase origin main
```

- [ ] **Step 3: Wait for Railway redeploy and query**

```bash
sleep 120
curl -s https://max-bot-production-7455.up.railway.app/diag/pulse | python3 -m json.tool
```

Inspect output. Most likely findings (based on prior context):
- `pulse_processes: NONE` — daemon never spawned, OR died immediately
- `dbus_socket: MISSING` — confirmed in earlier Playwright logs ("Failed to connect to socket /run/dbus/system_bus_socket")
- `runtime_dir_listing` — should show contents if Pulse tried to write there

The diag output tells us the exact next fix. **Pause here, paste the JSON output back into the executing context, and the next task is informed by it.**

---

## Task D.2: Fix PulseAudio startup

**Files:**
- Modify: `Dockerfile` — the embedded `/start.sh` heredoc

This task is *conditional on D.1's findings*. The fix is one of these three (in order of likelihood):

**Hypothesis A (most likely):** PulseAudio dies because it can't connect to dbus. Fix: pass `--disable-shm` and `--exit-idle-time=-1` to the start command, OR add a minimal system dbus daemon.

**Hypothesis B:** Runtime dir perms are wrong because `/tmp/pulse` doesn't exist or has wrong owner. Fix: `mkdir -p /tmp/pulse && chown $(id -u):$(id -g) /tmp/pulse && chmod 700 /tmp/pulse` before the `pulseaudio --start`.

**Hypothesis C:** Running as root prevents Pulse from running (it normally refuses). Fix: pass `--system` flag OR run as a non-root user.

After D.1's diag tells us which, make ONE targeted edit to the `/start.sh` heredoc in the Dockerfile. The current command is:

```
pulseaudio --start --log-target=stderr --log-level=notice &
```

After this task it should look something like:

```
mkdir -p /tmp/pulse && chmod 700 /tmp/pulse
pulseaudio --start --log-target=stderr --log-level=info --disable-shm --exit-idle-time=-1 &
```

OR a more drastic alternative — drop `--start` (which forks) and run as foreground daemon in a separate background process:

```
pulseaudio --daemonize=no --disallow-exit --disable-shm --log-target=stderr --log-level=info > /tmp/pulse.log 2>&1 &
```

ALSO add a default-source set immediately after `pactl load-module module-virtual-source`:

```
pactl set-default-source virtual_mic
```

- [ ] **Step 1: Apply the targeted Dockerfile change**

Edit the heredoc lines specifically. Don't rewrite the whole /start.sh.

- [ ] **Step 2: Commit + PR + deploy**

```bash
git checkout -b milestone-d/fix-pulseaudio
git add Dockerfile
git commit -m "fix(d.2): pulseaudio startup — <one-line rationale from D.1 diag>"
git push -u origin milestone-d/fix-pulseaudio
gh pr create --base main --head milestone-d/fix-pulseaudio --title "D.2: PulseAudio startup fix" --body "Based on /diag/pulse output from D.1."
gh pr merge --merge --delete-branch
git checkout main && git pull --rebase origin main
```

- [ ] **Step 3: Wait for redeploy + verify**

```bash
sleep 120
curl -s https://max-bot-production-7455.up.railway.app/diag/pulse | python3 -m json.tool
```

**Acceptance:** `pulse_processes` shows a running pulseaudio process. `try_pactl_info` returns a non-error response with `Server String: ...`. `pulse_sources` (from base `/diag`) lists both `virtual_mic` and `virtual_speaker.monitor`.

If still failing, iterate D.2 with the next hypothesis. Cap at three iterations — if Pulse won't run after three targeted fixes, abandon Pulse and switch to the Web Audio alternative (Hypothesis D: use `audioCtx.createOscillator()` or load `--use-file-for-fake-audio-capture` Chrome flag with a fifo). Document the abandonment in CLAUDE-NOTES.md.

---

## Task D.3: AudioInject module — failing tests (TDD red)

**Files:**
- Create: `src/bot/audioInject.test.ts`

`AudioInject` wraps the per-bot ffmpeg subprocess. Tests mock `child_process.spawn` so they don't actually invoke ffmpeg.

- [ ] **Step 1: Create the test file**

```typescript
// src/bot/audioInject.test.ts
import { EventEmitter } from 'events'

import { AudioInject } from './audioInject'

// Mock child_process.spawn to capture args + provide a fake subprocess.
jest.mock('child_process', () => {
    const writeMock = jest.fn()
    const endMock = jest.fn()
    const killMock = jest.fn()
    const onErrorListeners: ((e: Error) => void)[] = []
    const onExitListeners: ((code: number) => void)[] = []

    const fakeChild: {
        stdin: { write: jest.Mock; end: jest.Mock }
        on: (ev: string, cb: (...args: unknown[]) => void) => void
        kill: jest.Mock
    } = {
        stdin: { write: writeMock, end: endMock },
        on: (ev, cb) => {
            if (ev === 'error') onErrorListeners.push(cb as (e: Error) => void)
            if (ev === 'exit') onExitListeners.push(cb as (code: number) => void)
        },
        kill: killMock,
    }

    const spawnMock = jest.fn(() => fakeChild)

    return {
        spawn: spawnMock,
        __mocks__: {
            spawnMock,
            writeMock,
            endMock,
            killMock,
            triggerError: (e: Error) => onErrorListeners.forEach((f) => f(e)),
            triggerExit: (code: number) => onExitListeners.forEach((f) => f(code)),
        },
    }
})

import * as child_process from 'child_process'
const mocks = (child_process as unknown as { __mocks__: Record<string, jest.Mock | ((arg: unknown) => void)> })
    .__mocks__

describe('AudioInject', () => {
    beforeEach(() => {
        ;(mocks.spawnMock as jest.Mock).mockClear()
        ;(mocks.writeMock as jest.Mock).mockClear()
        ;(mocks.endMock as jest.Mock).mockClear()
        ;(mocks.killMock as jest.Mock).mockClear()
    })

    it('spawns ffmpeg with f32le float-input + alsa pulse:virtual_mic output', () => {
        new AudioInject({ sampleRate: 16000, alsaDevice: 'pulse:virtual_mic' })
        const args = (mocks.spawnMock as jest.Mock).mock.calls[0][1] as string[]
        expect((mocks.spawnMock as jest.Mock).mock.calls[0][0]).toBe('ffmpeg')
        expect(args).toEqual(
            expect.arrayContaining([
                '-f', 'f32le',
                '-ar', '16000',
                '-ac', '1',
                '-i', '-',
                '-f', 'alsa',
                '-acodec', 'pcm_s16le',
                'pulse:virtual_mic',
            ]),
        )
    })

    it('converts Int16 buffer to Float32 and writes to ffmpeg stdin', () => {
        const inj = new AudioInject({ sampleRate: 16000, alsaDevice: 'pulse:virtual_mic' })
        // 4 Int16 samples: [16384, -16384, 32767, -32768] little-endian
        const buf = Buffer.alloc(8)
        buf.writeInt16LE(16384, 0)
        buf.writeInt16LE(-16384, 2)
        buf.writeInt16LE(32767, 4)
        buf.writeInt16LE(-32768, 6)

        inj.pushInt16Buffer(buf)

        expect((mocks.writeMock as jest.Mock)).toHaveBeenCalled()
        const written: Buffer = (mocks.writeMock as jest.Mock).mock.calls[0][0]
        // 4 Float32 = 16 bytes
        expect(written.length).toBe(16)
        const f32 = new Float32Array(
            written.buffer,
            written.byteOffset,
            4,
        )
        expect(f32[0]).toBeCloseTo(16384 / 32768, 3)
        expect(f32[1]).toBeCloseTo(-16384 / 32768, 3)
        expect(f32[2]).toBeCloseTo(32767 / 32768, 3)
        expect(f32[3]).toBeCloseTo(-32768 / 32768, 3)
    })

    it('stop() ends ffmpeg stdin and kills the process', () => {
        const inj = new AudioInject({ sampleRate: 16000, alsaDevice: 'pulse:virtual_mic' })
        inj.stop()
        expect(mocks.endMock).toHaveBeenCalled()
        expect(mocks.killMock).toHaveBeenCalled()
    })

    it('emits "exit" event when the ffmpeg subprocess exits', (done) => {
        const inj = new AudioInject({ sampleRate: 16000, alsaDevice: 'pulse:virtual_mic' })
        inj.on('exit', (code: number) => {
            expect(code).toBe(0)
            done()
        })
        ;(mocks.triggerExit as (n: number) => void)(0)
    })
})
```

- [ ] **Step 2: Verify red**

```bash
./node_modules/.bin/jest src/bot/audioInject.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAIL — "Cannot find module './audioInject'".

---

## Task D.4: AudioInject module — passing impl (TDD green)

**Files:**
- Create: `src/bot/audioInject.ts`

- [ ] **Step 1: Create the implementation**

```typescript
// src/bot/audioInject.ts
//
// Per-bot ffmpeg subprocess that converts incoming Int16 PCM (from
// the /ws_in/:bot_id WebSocket) into Float32 and pipes it into the
// PulseAudio `virtual_mic` source via ALSA's pulse plugin.
//
// Chrome (launched with --use-fake-ui-for-media-stream) auto-grants
// the bot's outgoing mic; whatever is on virtual_mic becomes Max's
// voice in the Meet call.
//
// Pattern reference: src/streaming.ts:560-607 + src/media_context.ts:145-166.
// We don't import — same decoupling reasons as audioCapture.ts.

import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'

export interface AudioInjectOptions {
    sampleRate: number
    /** PulseAudio source target via ALSA plugin. Default 'pulse:virtual_mic'. */
    alsaDevice?: string
}

export class AudioInject extends EventEmitter {
    private readonly child: ChildProcess
    private stopped = false

    constructor(opts: AudioInjectOptions) {
        super()
        const device = opts.alsaDevice ?? 'pulse:virtual_mic'
        const args = [
            '-loglevel', 'warning',
            '-f', 'f32le',
            '-ar', String(opts.sampleRate),
            '-ac', '1',
            '-i', '-',
            '-f', 'alsa',
            '-acodec', 'pcm_s16le',
            device,
        ]
        this.child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
        this.child.on('error', (err) => this.emit('error', err))
        this.child.on('exit', (code) => this.emit('exit', code ?? -1))
    }

    /** Accepts a buffer of little-endian Int16 PCM samples. */
    pushInt16Buffer(buf: Buffer): void {
        if (this.stopped || !this.child.stdin || this.child.stdin.destroyed) {
            return
        }
        const n = buf.length / 2
        const f32 = new Float32Array(n)
        for (let i = 0; i < n; i++) {
            const s = buf.readInt16LE(i * 2)
            f32[i] = s / 32768
        }
        this.child.stdin.write(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength))
    }

    stop(): void {
        if (this.stopped) return
        this.stopped = true
        try {
            this.child.stdin?.end()
        } catch {
            /* ignore */
        }
        try {
            this.child.kill('SIGTERM')
        } catch {
            /* ignore */
        }
    }
}
```

- [ ] **Step 2: Verify green**

```bash
./node_modules/.bin/jest src/bot/audioInject.test.ts --runInBand 2>&1 | tail -10
```

Expected: 4/4 pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/audioInject.ts src/bot/audioInject.test.ts
git commit -m "feat(bot): AudioInject — ffmpeg subprocess Int16→Float32→pulse:virtual_mic"
```

---

## Task D.5: WebSocket `/ws_in/:bot_id` — failing test (TDD red)

**Files:**
- Modify: `src/bot/wsServer.test.ts`

Append new tests asserting `/ws_in/:bot_id` accepts upgrade and forwards bytes to `session.audioInject.pushInt16Buffer`.

- [ ] **Step 1: Add tests at the bottom of `wsServer.test.ts`**

```typescript
describe('attachWebSocketServer — /ws_in/:bot_id', () => {
    afterEach(() => _clearAllSessions())

    it('rejects unknown bot_id with close code 1008', async () => {
        const env = await spinUp()
        const ws = new WebSocket(`ws://localhost:${env.port}/ws_in/nope`)
        const code: number = await new Promise((res) => {
            ws.on('close', (c) => res(c))
            ws.on('error', () => {})
        })
        expect(code).toBe(1008)
        await env.close()
    })

    it('forwards binary frames to session.audioInject.pushInt16Buffer', async () => {
        const pushMock = jest.fn()
        const inj = {
            pushInt16Buffer: pushMock,
            stop: jest.fn(),
        }
        const stream = new AudioStream({ srcSampleRate: 16000, dstSampleRate: 16000 })
        registerSession({
            bot_id: 'inj',
            meeting_url: 'https://meet.google.com/x',
            bot_name: 'Max',
            startedAt: new Date(),
            audioStream: stream,
            audioInject: inj as never,
            page: {} as never,
            close: async () => {},
        })
        const env = await spinUp()
        const ws = new WebSocket(`ws://localhost:${env.port}/ws_in/inj`)
        await new Promise<void>((res) => ws.on('open', () => res()))
        const buf = Buffer.alloc(4)
        buf.writeInt16LE(100, 0)
        buf.writeInt16LE(200, 2)
        ws.send(buf, { binary: true })
        await new Promise((r) => setTimeout(r, 50))
        expect(pushMock).toHaveBeenCalled()
        ws.close()
        await env.close()
    })
})
```

- [ ] **Step 2: Verify red**

```bash
./node_modules/.bin/jest src/bot/wsServer.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAILs around `audioInject` field missing OR `/ws_in/` returning unexpected codes.

---

## Task D.6: WebSocket `/ws_in/:bot_id` — passing impl (TDD green)

**Files:**
- Modify: `src/bot/wsServer.ts`
- Modify: `src/bot/sessions.ts` to add `audioInject` field

- [ ] **Step 1: Update `JoinSession` interface**

```typescript
// src/bot/sessions.ts (add the field)
import type { AudioInject } from './audioInject'

export interface JoinSession {
    bot_id: string
    meeting_url: string
    bot_name: string
    startedAt: Date
    audioStream: AudioStream
    audioInject: AudioInject
    page: Page
    close: () => Promise<void>
}
```

Update existing `sessions.test.ts` stubs to include an `audioInject` stub.

- [ ] **Step 2: Add `/ws_in/:bot_id` handler in `wsServer.ts`**

```typescript
// Inside attachWebSocketServer, after the existing /ws/ handler block,
// add a second route in the same upgrade listener:

const WS_PATH_OUT_RE = /^\/ws\/([A-Za-z0-9_-]+)\/?$/
const WS_PATH_IN_RE = /^\/ws_in\/([A-Za-z0-9_-]+)\/?$/

// In the upgrade handler, after the existing match, add:
const inMatch = WS_PATH_IN_RE.exec(url)
if (inMatch) {
    const bot_id = inMatch[1]
    const session = getSession(bot_id)
    if (!session) {
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.close(1008, 'unknown bot_id')
        })
        return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (m: WebSocket.RawData) => {
            if (m instanceof Buffer) {
                session.audioInject.pushInt16Buffer(m)
            }
        })
    })
    return
}
```

- [ ] **Step 3: Verify green**

```bash
./node_modules/.bin/jest src/bot/wsServer.test.ts src/bot/sessions.test.ts --runInBand 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add src/bot/wsServer.ts src/bot/wsServer.test.ts src/bot/sessions.ts src/bot/sessions.test.ts
git commit -m "feat(bot): /ws_in/:bot_id WebSocket — forwards Int16 PCM to AudioInject"
```

---

## Task D.7: Wire into `app.ts` + `/diag/inject/:bot_id`

**Files:**
- Modify: `src/app.ts`
- Modify: `src/app.test.ts`

- [ ] **Step 1: In `/join` flow, create AudioInject alongside AudioStream**

```typescript
// inside /join handler, near where AudioStream is created:
import { AudioInject } from './bot/audioInject'

const audioInject = new AudioInject({
    sampleRate: OUTPUT_SAMPLE_RATE,
})
// ... pass to registerSession ...
registerSession({
    bot_id,
    meeting_url,
    bot_name,
    startedAt: new Date(),
    audioStream,
    audioInject,
    page,
    close: async () => {
        audioStream.stop()
        audioInject.stop()
        await close()
    },
})
```

- [ ] **Step 2: Add `/diag/inject/:bot_id` route**

```typescript
app.get('/diag/inject/:bot_id', (req: Request, res: Response) => {
    const session = getSession(req.params.bot_id)
    if (!session) {
        res.status(404).json({ error: 'unknown bot_id' })
        return
    }
    // AudioInject exposes its child for diag.
    const child = (session.audioInject as unknown as { child?: { pid?: number; killed?: boolean } }).child
    res.status(200).json({
        bot_id: req.params.bot_id,
        ffmpeg_pid: child?.pid ?? null,
        ffmpeg_killed: child?.killed ?? null,
    })
})
```

- [ ] **Step 3: Update app.test.ts mocks**

Mock the `audioInject` field on session creation (constructor's child_process.spawn is already module-mocked when `AudioInject` is mocked).

- [ ] **Step 4: Run all tests as regression**

```bash
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | tail -8
```

Expected: all green (29 + 6 audioInject + 2 wsServer = 37 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/app.test.ts
git commit -m "feat(app): wire AudioInject into /join + /leave + /diag/inject/:bot_id"
```

---

## Task D.8: `scripts/play-audio-to-bot.js` — test client

**Files:**
- Create: `scripts/play-audio-to-bot.js`

- [ ] **Step 1: Create the script**

```javascript
#!/usr/bin/env node
// Stream a WAV file's PCM into a bot's /ws_in/:bot_id at real-time pace.
//
// Usage:
//   node scripts/play-audio-to-bot.js <ws_in url> <in.wav> [chunk_ms=100]
//
// The WAV must be 16-bit mono 16 kHz. (Convert with:
//   ffmpeg -i input.mp3 -ar 16000 -ac 1 -sample_fmt s16 out.wav)

const fs = require('fs')
const WebSocket = require('ws')

const [, , url, wavPath, chunkMsArg] = process.argv
if (!url || !wavPath) {
    console.error('usage: play-audio-to-bot.js <ws_in url> <in.wav> [chunk_ms=100]')
    process.exit(2)
}
const chunkMs = Number(chunkMsArg) || 100

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const chunkBytes = (SAMPLE_RATE * BYTES_PER_SAMPLE * chunkMs) / 1000

const wav = fs.readFileSync(wavPath)
const data = wav.slice(44) // skip header
console.log(`loaded ${data.length} bytes (${(data.length / 32000).toFixed(1)}s @ 16kHz mono Int16)`)

const ws = new WebSocket(url)

ws.on('open', () => {
    console.log('ws open, streaming...')
    let offset = 0
    const tick = () => {
        if (offset >= data.length) {
            ws.close()
            return
        }
        const end = Math.min(offset + chunkBytes, data.length)
        const chunk = data.slice(offset, end)
        ws.send(chunk, { binary: true })
        offset = end
        setTimeout(tick, chunkMs)
    }
    tick()
})

ws.on('close', () => console.log('done'))
ws.on('error', (e) => {
    console.error('ws error:', e.message)
    process.exit(1)
})
```

- [ ] **Step 2: Commit**

```bash
chmod +x scripts/play-audio-to-bot.js
git add scripts/play-audio-to-bot.js
git commit -m "scripts: WAV-to-bot injection tool for milestone D acceptance"
```

---

## Task D.9: Push, PR, merge, Railway deploy

- [ ] **Step 1: Push + PR**

```bash
git push -u origin milestone-d/audio-inject
gh pr create --base main --head milestone-d/audio-inject \
    --title "Milestone D: WebSocket audio injection into Google Meet" \
    --body "Adds /ws_in/:bot_id. ffmpeg subprocess pumps incoming Int16 PCM into PulseAudio virtual_mic source; Chrome's getUserMedia picks it up as Max's voice."
gh pr merge --merge --delete-branch
```

- [ ] **Step 2: Wait + verify**

```bash
sleep 120
curl -s https://max-bot-production-7455.up.railway.app/health
curl -s https://max-bot-production-7455.up.railway.app/diag/pulse | python3 -m json.tool | head -20
```

Acceptance: `/health` → 200, `/diag/pulse` shows pulseaudio running + virtual_mic listed.

---

## Task D.10: Live acceptance — Suren hears audio from Max

**Files:** None modified.

Suren-in-the-loop. Manual.

- [ ] **Step 1: Prepare a test WAV**

Suren creates or finds a short WAV file (~10s of any speech). If needed, convert:

```bash
ffmpeg -i any.mp3 -ar 16000 -ac 1 -sample_fmt s16 /tmp/test.wav
```

- [ ] **Step 2: Suren joins a fresh Google Meet**

- [ ] **Step 3: I send POST /join**

```bash
curl -s -X POST https://max-bot-production-7455.up.railway.app/join \
    -H 'content-type: application/json' \
    -d '{"meeting_url":"<URL>","bot_name":"Max"}'
# → {"bot_id":"<uuid>"}
```

- [ ] **Step 4: Stream the WAV into the bot**

```bash
node scripts/play-audio-to-bot.js \
    wss://max-bot-production-7455.up.railway.app/ws_in/<bot_id> \
    /tmp/test.wav
```

- [ ] **Step 5: Suren confirms hearing Max say the WAV's contents in the meeting**

- [ ] **Step 6: Cleanup**

```bash
curl -X POST https://max-bot-production-7455.up.railway.app/leave/<bot_id>
```

- [ ] **Step 7: Update CLAUDE-NOTES.md**

---

## Milestone D acceptance checklist

- [ ] All Jest tests pass locally
- [ ] Railway deploy `ACTIVE`, `/health` 200
- [ ] `/diag/pulse` shows pulseaudio running, virtual_mic present, default-source = virtual_mic
- [ ] `POST /join` succeeds
- [ ] `node scripts/play-audio-to-bot.js .../ws_in/<id> test.wav` runs without error
- [ ] **Suren confirms hearing the WAV's audio in the meeting from Max**
- [ ] `POST /leave/<id>` cleans up the ffmpeg subprocess
- [ ] CLAUDE-NOTES.md updated

When checked → Milestone D complete, ready for Milestone E (max-brain integration — a 30-line edit on max-brain plus a redeploy).

---

## Self-review

**Spec coverage:**
- ✅ Milestone D goal from design spec ("PCM audio pushed to the bot via WebSocket is heard by other meeting participants") is the acceptance criterion of D.10.
- ✅ PulseAudio routing front-loaded — the spec called it out as the main risk.
- ✅ Pattern reuses upstream (`streaming.ts` + `media_context.ts`) without imports — same approach as C.

**Placeholder scan:**
- D.2 has multiple hypotheses by design (we don't know yet what's wrong with PulseAudio). The plan flags this and gives concrete fixes per hypothesis. Not a placeholder failure.
- D.7 Step 3 says "Mock the audioInject field" — when executing, follow the same `{} as never` pattern used in earlier mocks for `page`.

**Type consistency:**
- `AudioInject` defined in D.4, used in `JoinSession` (D.6), constructed in `/join` (D.7), forwarded-to in `/ws_in/` (D.6).
- `pushInt16Buffer(buf: Buffer)` is the single mutating method, consistent between tests + impl + caller.

**Scope check:**
- Plan focused on Milestone D only.
- Estimate per spec: 5–7 days. The PulseAudio blocker (D.1+D.2) is the main risk; everything downstream is mechanical TDD.
