# Max Self-Hosted Bot — Milestone C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When max-bot is in a Google Meet, a WebSocket client connecting to `wss://max-bot-production-7455.up.railway.app/ws/{bot_id}` receives the meeting's mixed audio as raw 16 kHz mono Int16 PCM in 100 ms chunks. Saving the stream to a WAV file plays back as recognisable meeting audio.

**Architecture:** Reuse upstream's Web Audio capture (`src/meeting/shared/audio-capture.ts`, `src/streaming.ts`) — proven code that injects JavaScript into Meet's page to mix all participants' audio via the Web Audio API and pipe samples back to Node through a Playwright `exposeFunction` callback. We refactor minimally to decouple from `GLOBAL` singleton, then route the samples into a per-`bot_id` WebSocket. The WebSocket protocol is byte-identical to what MBaaS sends max-brain today, so Milestone E's max-brain integration becomes a one-line URL swap.

**Tech Stack:** TypeScript, Node 20, Playwright, `ws` (already in upstream deps), Web Audio API, Int16 PCM resampling (ffmpeg subprocess OR an in-process resampler — TBD in C.2 after measuring).

**Pre-conditions already in place:**
- Milestone B is shipped (commit `245742d` on `main`).
- `https://max-bot-production-7455.up.railway.app/health`, `/diag`, `/join`, `/leave/:bot_id` all working.
- Live `/diag` confirms: Xvfb running, DISPLAY=`:99`, `/start.sh` is the ENTRYPOINT.
- Upstream code at `src/meeting/shared/audio-capture.ts` (460 lines) + `src/streaming.ts` (715 lines) is preserved, dormant, ready to be wired in.

**What ships at end of Milestone C:**
- New WebSocket endpoint `/ws/:bot_id` (upgrade on the same HTTP port 8080)
- Connecting clients receive 100 ms chunks of 16 kHz mono Int16 PCM from the meeting Max is in
- A small test harness (`scripts/save-meeting-audio.js`) saves a 30 s sample to a `.wav` file for verification
- `GET /diag` extended to report active WebSocket clients
- `/health`, `/join`, `/leave/:bot_id` continue to work

**Out of scope for Milestone C (deferred):**
- Audio injection into the meeting (Milestone D — PulseAudio + Chrome mic)
- max-brain integration (Milestone E)
- Stop-on-disconnect, automatic reconnect with backoff for the WS (Milestone F)
- Multi-bot audio routing (single bot in v1)
- Recording the captured audio to S3 (not needed; max-brain consumes the live stream)

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `src/bot/audioCapture.ts` | Create | Adapted from upstream `src/meeting/shared/audio-capture.ts`. Injects Web Audio mixer into the Meet page, exposes an `onPcmChunk` callback to Node. No `GLOBAL` singleton dependence. |
| `src/bot/audioCapture.test.ts` | Create | Unit tests covering: chunk callback fires, resampler outputs 16 kHz, sampling rate metadata captured, stop() tears everything down. Playwright + Web Audio mocked. |
| `src/bot/audioStream.ts` | Create | Per-bot audio stream owner. Wires `audioCapture` → Int16 PCM resampling → `EventEmitter` so multiple consumers (WebSocket, future recording, future analytics) can subscribe. |
| `src/bot/audioStream.test.ts` | Create | Unit tests for resampling, chunk timing, EventEmitter lifecycle. |
| `src/bot/wsServer.ts` | Create | WebSocket upgrade handler. Routes `/ws/:bot_id` to the right `audioStream`'s subscriber. Closes the WS when the bot leaves. |
| `src/bot/wsServer.test.ts` | Create | Unit tests: accepts upgrade on `/ws/:bot_id`, rejects unknown bot_id with 404 upgrade response, forwards PCM bytes binary-mode, closes cleanly on bot leave. |
| `src/app.ts` | Modify | Stop using `app.listen()` directly. Create an `http.Server`, attach Express, attach the WebSocket upgrade handler, then listen. Extend `joinMeet()` call so audio capture starts when the bot joins. Extend `/diag` to report active WS clients. |
| `src/app.test.ts` | Modify | Add cases for the WS handshake (`upgrade` to `ws://localhost:.../ws/<bot_id>`) and the diag extension. |
| `src/bot/joinMeet.ts` | Modify | Return the Playwright `Page` (alongside `bot_id`, `close`) so `app.ts` can pass it to `audioCapture.attach(page)`. No selector changes. |
| `src/bot/sessions.ts` | Modify | Extend `JoinSession` with an `audioStream: AudioStream` field so `/leave` can stop it. |
| `scripts/save-meeting-audio.js` | Create | Tiny Node script: connect to `ws://localhost:PORT/ws/:bot_id`, write incoming PCM to a `.wav` file with proper RIFF header. Used for the acceptance test. |
| `Dockerfile` | Possibly modify | If we go with the ffmpeg-subprocess resampling path, no change (ffmpeg already installed). If pure JS resampler, no change. |
| `docs/CLAUDE-NOTES.md` | Modify | Append Milestone C decisions + gotchas. |

**Files we deliberately do NOT touch in Milestone C:**
- `src/main.ts`, `src/server.ts`, `src/meeting/`, `src/streaming.ts` (we reference for selectors/patterns but never import — same pattern as Milestone B), every other upstream file.

---

## Decisions locked in for Milestone C

- **Reuse Web Audio capture approach, not PulseAudio-sink-monitor.** The original design spec (section 4.1) suggested PulseAudio sink → ffmpeg. Upstream actually uses a Web Audio approach: inject JS into the Meet page, intercept all `<audio>` elements via Web Audio API graph, mix them, pipe samples back to Node via `page.exposeFunction`. The Web Audio approach is independent of PulseAudio (which is broken in our container — separate bug, deferred to Milestone D) and lets us ship Milestone C without first fixing Pulse.
- **Minimal adaptation, not blind copy, of `src/meeting/shared/audio-capture.ts` + `src/streaming.ts`.** Upstream's `Streaming` class is tied to `GLOBAL.get()` for config (sample rate, output URL, etc.). We create `src/bot/audioCapture.ts` and `src/bot/audioStream.ts` that contain the *Web Audio injection logic* without any singleton coupling, taking config as constructor args.
- **WebSocket protocol matches MBaaS exactly:** binary frames, each frame is one 100 ms chunk of mono 16-bit signed PCM at 16 000 Hz. No JSON envelope, no chunk metadata header. This is exactly what max-brain's existing WebSocket bridge expects from MBaaS today. Milestone E will be a one-line URL swap.
- **Resampling:** start with a pure-JS approach (linear interpolation, ~5 lines), measure CPU vs ffmpeg-subprocess in C.4. Keep ffmpeg as fallback.
- **Single-bot, single-listener.** `/ws/:bot_id` accepts exactly one client at a time. Subsequent connections to the same bot_id are rejected with WS close code 1008. v1 scope; multi-listener fanout deferred.

---

## Pre-work — branch setup

### Task C.0: Branch from `main`

**Files:** None modified.

- [ ] **Step 1: Pull latest main + branch**

```bash
cd ~/Documents/Claude/max-bot
git checkout main
git pull origin main
git checkout -b milestone-c/audio-capture
```

- [ ] **Step 2: Verify baseline**

```bash
source ~/.nvm/nvm.sh && nvm use 20
unset NODE_ENV
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | tail -10
```

Expected: 16/16 from Milestone A+B tests still pass.

---

## Task C.1: Read upstream audio capture + streaming code

**Files:** None modified. Pure investigation. Outputs notes for design refinement, not committed code.

- [ ] **Step 1: Read `src/meeting/shared/audio-capture.ts` start-to-finish**

```bash
cat src/meeting/shared/audio-capture.ts | less
```

Look for:
- The browser-side script (likely a `page.evaluate(() => { ... })` block or `page.addInitScript`).
- The callback path from browser → Node (`page.exposeFunction` is the usual mechanism).
- The sample-rate handling — does it report what Meet provides (typically 48 kHz) or pre-resample to 16 kHz?
- Stop / cleanup contract.

- [ ] **Step 2: Read `src/streaming.ts` relevant sections**

Particularly lines around `pushAudioFrame`, `processAudioChunk`, `setupOutputWebSocket`. Note:
- Where Int16 conversion happens (we saw `// Convert to Int16 for WebSocket transmission` at line 219).
- The chunk-batching pattern.
- The reconnect/backoff logic (deferred to Milestone F — but understand the shape).

- [ ] **Step 3: Distill findings into `docs/CLAUDE-NOTES.md`**

Append a new subsection titled `## Milestone C — upstream audio capture notes` with bullets:
- Browser-side architecture (selector / Web Audio graph / postMessage mechanism)
- Node-side ingestion mechanism (`exposeFunction` vs other)
- Native sample rate from Meet (47 999 / 48 000)
- Where Int16 conversion happens
- What `GLOBAL` calls would need to be removed for our copy

Commit this exploration:

```bash
git add docs/CLAUDE-NOTES.md
git commit -m "docs: milestone C upstream audio capture inventory"
```

---

## Task C.2: Choose resampler — JS linear interp vs ffmpeg subprocess

**Files:** None modified. Outputs a decision recorded in CLAUDE-NOTES.md.

Background: Meet's Web Audio typically reports 48 000 Hz mono. We need 16 000 Hz mono Int16. Two options:

| Approach | Pros | Cons |
|---|---|---|
| Linear interpolation in JS, ~30 lines | Zero subprocess overhead, pure Node, easy to test | Slight aliasing artefacts (probably inaudible for STT use case) |
| Spawn `ffmpeg -i - -ar 16000 -ac 1 -f s16le -` per session | High-quality resampling, well-tested | Subprocess management, stdin/stdout piping, more failure modes |

- [ ] **Step 1: Prototype the JS resampler in a scratch file**

`scripts/scratch-resampler.js`:

```javascript
// Quick prototype: 48000 Hz Float32 → 16000 Hz Int16, linear interp.
function resampleAndInt16(float32input, srcRate, dstRate) {
    const ratio = srcRate / dstRate
    const outLen = Math.floor(float32input.length / ratio)
    const out = new Int16Array(outLen)
    for (let i = 0; i < outLen; i++) {
        const srcIdx = i * ratio
        const i0 = Math.floor(srcIdx)
        const i1 = Math.min(i0 + 1, float32input.length - 1)
        const frac = srcIdx - i0
        const sample = float32input[i0] * (1 - frac) + float32input[i1] * frac
        // Clamp to [-1, 1] then scale to Int16.
        const clamped = Math.max(-1, Math.min(1, sample))
        out[i] = Math.round(clamped * 32767)
    }
    return out
}

// Sanity check on a sine wave.
const ms = 100
const srcRate = 48000
const samples = (srcRate * ms) / 1000
const input = new Float32Array(samples)
for (let i = 0; i < samples; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / srcRate) * 0.5
const out = resampleAndInt16(input, 48000, 16000)
console.log(`Input ${samples} samples @ 48k → Output ${out.length} samples @ 16k`)
console.log(`First 5 int16:`, Array.from(out.slice(0, 5)))
```

Run: `node scripts/scratch-resampler.js`. Expected: `Input 4800 samples @ 48k → Output 1600 samples @ 16k`.

- [ ] **Step 2: Record decision in CLAUDE-NOTES.md**

If the JS prototype works and sounds OK in C.10's WAV listening test, lock in: "JS linear-interpolation resampler. Reason: fewer moving parts. Quality is good enough for STT downstream."

If it sounds bad, switch to ffmpeg subprocess in C.4.

- [ ] **Step 3: Don't commit the scratch script.** Delete it after the decision is logged.

---

## Task C.3: AudioStream module — failing tests (TDD red)

**Files:**
- Create: `src/bot/audioStream.test.ts`

`AudioStream` is the per-bot fan-out point. It accepts incoming Float32 frames (from Web Audio in C.5), resamples to 16 kHz mono Int16, and emits `chunk` events to subscribers (one of which will be the WebSocket).

- [ ] **Step 1: Create the test file**

```typescript
// src/bot/audioStream.test.ts
import { AudioStream } from './audioStream'

describe('AudioStream', () => {
    it('emits chunk events when pushFloat32 is called', () => {
        const stream = new AudioStream({ srcSampleRate: 48000, dstSampleRate: 16000 })
        const chunks: Buffer[] = []
        stream.on('chunk', (c: Buffer) => chunks.push(c))

        const input = new Float32Array(4800) // 100 ms @ 48 kHz
        for (let i = 0; i < input.length; i++) input[i] = 0.5
        stream.pushFloat32(input)

        expect(chunks).toHaveLength(1)
        expect(chunks[0].length).toBe(1600 * 2) // 1600 samples * 2 bytes (Int16)
    })

    it('resamples 48 kHz → 16 kHz at 3:1 ratio', () => {
        const stream = new AudioStream({ srcSampleRate: 48000, dstSampleRate: 16000 })
        const out: Buffer[] = []
        stream.on('chunk', (c) => out.push(c))

        const input = new Float32Array(9600) // 200 ms @ 48 kHz
        stream.pushFloat32(input)

        expect(out).toHaveLength(1)
        expect(out[0].length).toBe(3200 * 2) // 3200 Int16 samples
    })

    it('clamps Float32 samples above 1.0 to Int16 max', () => {
        const stream = new AudioStream({ srcSampleRate: 16000, dstSampleRate: 16000 })
        let captured: Buffer | null = null
        stream.on('chunk', (c) => (captured = c))

        const input = new Float32Array(160)
        input.fill(2.0) // way above range
        stream.pushFloat32(input)

        expect(captured).not.toBeNull()
        // First Int16 sample should be max value 32767.
        const int16 = captured!.readInt16LE(0)
        expect(int16).toBe(32767)
    })

    it('stop() removes all listeners and prevents further chunks', () => {
        const stream = new AudioStream({ srcSampleRate: 48000, dstSampleRate: 16000 })
        const chunks: Buffer[] = []
        stream.on('chunk', (c) => chunks.push(c))
        stream.stop()
        stream.pushFloat32(new Float32Array(4800))
        expect(chunks).toHaveLength(0)
    })
})
```

- [ ] **Step 2: Verify red**

```bash
./node_modules/.bin/jest src/bot/audioStream.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAIL "Cannot find module './audioStream'".

---

## Task C.4: AudioStream module — passing impl (TDD green)

**Files:**
- Create: `src/bot/audioStream.ts`

- [ ] **Step 1: Create the implementation**

```typescript
// src/bot/audioStream.ts
//
// Per-bot audio fan-out. Receives Float32 frames from the browser-injected
// Web Audio mixer (see audioCapture.ts), resamples to dstSampleRate,
// converts to Int16 PCM, and emits 'chunk' events.
//
// Listeners (e.g. the /ws/:bot_id WebSocket) subscribe via on('chunk').
// On stop(), all listeners are removed so the stream becomes a no-op.

import { EventEmitter } from 'events'

export interface AudioStreamOptions {
    srcSampleRate: number
    dstSampleRate: number
}

export class AudioStream extends EventEmitter {
    private readonly srcSampleRate: number
    private readonly dstSampleRate: number
    private stopped = false

    constructor(opts: AudioStreamOptions) {
        super()
        this.srcSampleRate = opts.srcSampleRate
        this.dstSampleRate = opts.dstSampleRate
    }

    pushFloat32(samples: Float32Array): void {
        if (this.stopped) return
        const int16 = this.resampleAndInt16(samples)
        // Convert Int16Array → little-endian Buffer.
        const buf = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength)
        this.emit('chunk', buf)
    }

    stop(): void {
        this.stopped = true
        this.removeAllListeners()
    }

    private resampleAndInt16(input: Float32Array): Int16Array {
        if (this.srcSampleRate === this.dstSampleRate) {
            const out = new Int16Array(input.length)
            for (let i = 0; i < input.length; i++) {
                const s = Math.max(-1, Math.min(1, input[i]))
                out[i] = Math.round(s * 32767)
            }
            return out
        }
        const ratio = this.srcSampleRate / this.dstSampleRate
        const outLen = Math.floor(input.length / ratio)
        const out = new Int16Array(outLen)
        for (let i = 0; i < outLen; i++) {
            const srcIdx = i * ratio
            const i0 = Math.floor(srcIdx)
            const i1 = Math.min(i0 + 1, input.length - 1)
            const frac = srcIdx - i0
            const sample = input[i0] * (1 - frac) + input[i1] * frac
            const clamped = Math.max(-1, Math.min(1, sample))
            out[i] = Math.round(clamped * 32767)
        }
        return out
    }
}
```

- [ ] **Step 2: Verify green**

```bash
./node_modules/.bin/jest src/bot/audioStream.test.ts --runInBand 2>&1 | tail -10
```

Expected: 4/4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/audioStream.ts src/bot/audioStream.test.ts
git commit -m "feat(bot): AudioStream — Float32 → resample → Int16 PCM with EventEmitter fanout"
```

---

## Task C.5: audioCapture module — failing test (TDD red)

**Files:**
- Create: `src/bot/audioCapture.test.ts`

`audioCapture` is the Playwright-side glue: given a `Page` already on the Meet, it injects a Web Audio capture script, exposes a function the browser can call to push samples, and forwards those samples to an `AudioStream`.

The browser-side script is non-trivial. For Milestone C we adapt the pattern from upstream's `src/meeting/shared/audio-capture.ts` (read in C.1). Tests mock the `Page` so we don't need a real browser.

- [ ] **Step 1: Create the test file**

```typescript
// src/bot/audioCapture.test.ts
import { attachAudioCapture } from './audioCapture'
import { AudioStream } from './audioStream'

// Mock Playwright Page.
function makeFakePage() {
    const exposedFunctions = new Map<string, (...args: unknown[]) => unknown>()
    return {
        exposedFunctions,
        exposeFunction: jest.fn(async (name: string, fn: (...a: unknown[]) => unknown) => {
            exposedFunctions.set(name, fn)
        }),
        evaluate: jest.fn(async () => {}),
        addInitScript: jest.fn(async () => {}),
    }
}

describe('attachAudioCapture', () => {
    it('exposes a sample-pushing function and calls it on Web Audio frames', async () => {
        const page = makeFakePage()
        const stream = new AudioStream({ srcSampleRate: 48000, dstSampleRate: 16000 })
        const chunks: Buffer[] = []
        stream.on('chunk', (c) => chunks.push(c))

        await attachAudioCapture(page as never, stream)

        // The expose function should have been registered.
        expect(page.exposeFunction).toHaveBeenCalledWith(
            'maxBotPushAudioFrame',
            expect.any(Function),
        )

        // Simulate the browser calling the exposed function with samples.
        const pushFn = page.exposedFunctions.get('maxBotPushAudioFrame')!
        const fakeFrame = new Array(4800).fill(0.1) // 100 ms @ 48 kHz, plain array
        const sampleRate = 48000
        await pushFn(fakeFrame, sampleRate)

        expect(chunks).toHaveLength(1)
    })

    it('passes the source sample rate through to the AudioStream', async () => {
        const page = makeFakePage()
        const stream = new AudioStream({ srcSampleRate: 48000, dstSampleRate: 16000 })
        const captured: number[] = []
        // Spy: we'll override pushFloat32 to record the array length.
        const origPush = stream.pushFloat32.bind(stream)
        stream.pushFloat32 = (arr: Float32Array) => {
            captured.push(arr.length)
            origPush(arr)
        }
        await attachAudioCapture(page as never, stream)
        const pushFn = page.exposedFunctions.get('maxBotPushAudioFrame')!
        await pushFn(new Array(4800).fill(0), 48000)
        expect(captured).toEqual([4800])
    })

    it('injects an init script that sets up Web Audio mixing on the Meet page', async () => {
        const page = makeFakePage()
        const stream = new AudioStream({ srcSampleRate: 48000, dstSampleRate: 16000 })
        await attachAudioCapture(page as never, stream)
        expect(page.addInitScript).toHaveBeenCalled()
        // The script source should reference maxBotPushAudioFrame.
        const callArg = page.addInitScript.mock.calls[0][0] as unknown
        const scriptStr = typeof callArg === 'function' ? callArg.toString() : String(callArg)
        expect(scriptStr).toContain('maxBotPushAudioFrame')
    })
})
```

- [ ] **Step 2: Verify red**

```bash
./node_modules/.bin/jest src/bot/audioCapture.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAIL "Cannot find module './audioCapture'".

---

## Task C.6: audioCapture module — passing impl (TDD green)

**Files:**
- Create: `src/bot/audioCapture.ts`

The browser-side script is a self-contained Web Audio API setup: find Meet's audio elements, mix them through a `ScriptProcessorNode` (or `AudioWorkletNode`), and pass each chunk back to Node via the exposed function. The actual script is adapted from upstream `src/meeting/shared/audio-capture.ts` lines TBD (filled in during C.1).

- [ ] **Step 1: Create the implementation**

```typescript
// src/bot/audioCapture.ts
//
// Inject a Web Audio mixer into the Meet page and route every captured
// 100 ms frame back to a local AudioStream.
//
// The browser-side script (BROWSER_SCRIPT below) is adapted from upstream
// src/meeting/shared/audio-capture.ts. We pull only the chunks-back-to-Node
// pipeline; the upstream version also handles WebRTC integration for
// recording — not needed here.

import type { Page } from 'playwright'

import { AudioStream } from './audioStream'

// Browser-side script. Runs inside the Meet page on every navigation.
// Sets up a Web Audio AudioContext, finds all <audio> elements (Meet's
// remote participants), routes them through a mixer + ScriptProcessor,
// and calls the exposed maxBotPushAudioFrame(sampleArray, sampleRate)
// once per 100 ms chunk.
//
// We use ScriptProcessor for portability — AudioWorklet would be cleaner
// but needs a separate module file served via blob URL, and Meet's CSP
// can be picky about that.
const BROWSER_SCRIPT = `
;(function setupMaxBotAudioCapture() {
    if (window.__maxBotAudioCaptureSetup) return
    window.__maxBotAudioCaptureSetup = true

    function attemptSetup() {
        // Lazily find <audio> elements as Meet adds them.
        const audios = Array.from(document.querySelectorAll('audio'))
        if (audios.length === 0) {
            setTimeout(attemptSetup, 1000)
            return
        }
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)()
            const mixer = ctx.createGain()
            mixer.gain.value = 1.0
            for (const audio of audios) {
                try {
                    const src = ctx.createMediaElementSource(audio)
                    src.connect(mixer)
                    // Continue piping to the speakers so the user (if any)
                    // can still hear the meeting. Important for debugging.
                    src.connect(ctx.destination)
                } catch (e) {
                    // already-attached audio elements throw; ignore.
                }
            }
            const bufferSize = 4096
            const proc = ctx.createScriptProcessor(bufferSize, 1, 1)
            mixer.connect(proc)
            proc.connect(ctx.destination)
            proc.onaudioprocess = (e) => {
                const ch0 = e.inputBuffer.getChannelData(0)
                // Copy because the underlying buffer is reused.
                const copy = new Array(ch0.length)
                for (let i = 0; i < ch0.length; i++) copy[i] = ch0[i]
                window.maxBotPushAudioFrame(copy, ctx.sampleRate)
            }
            // Watch for newly-added audio elements (new participants).
            const obs = new MutationObserver(() => {
                const next = document.querySelectorAll('audio')
                for (const audio of next) {
                    if (audio.__maxBotWired) continue
                    audio.__maxBotWired = true
                    try {
                        const src = ctx.createMediaElementSource(audio)
                        src.connect(mixer)
                        src.connect(ctx.destination)
                    } catch (e) {
                        /* already wired by another path */
                    }
                }
            })
            obs.observe(document.body, { childList: true, subtree: true })
        } catch (e) {
            console.error('[max-bot] audio capture setup failed:', e)
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attemptSetup)
    } else {
        attemptSetup()
    }
})()
`

export async function attachAudioCapture(
    page: Page,
    stream: AudioStream,
): Promise<void> {
    // Expose the Node-side receiver before the page script runs.
    await page.exposeFunction(
        'maxBotPushAudioFrame',
        (samples: number[], _sampleRate: number) => {
            const f32 = Float32Array.from(samples)
            stream.pushFloat32(f32)
        },
    )

    // Run the browser-side capture script on every navigation.
    await page.addInitScript(BROWSER_SCRIPT)

    // If the page is already on Meet (it should be, since joinMeet calls
    // this AFTER goto), kick off setup once.
    await page.evaluate(BROWSER_SCRIPT).catch(() => {
        // already-set sentinel, fine.
    })
}
```

- [ ] **Step 2: Verify green**

```bash
./node_modules/.bin/jest src/bot/audioCapture.test.ts --runInBand 2>&1 | tail -10
```

Expected: 3/3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/audioCapture.ts src/bot/audioCapture.test.ts
git commit -m "feat(bot): audioCapture — inject Web Audio mixer into Meet page"
```

---

## Task C.7: Extend `joinMeet` to surface the Page

**Files:**
- Modify: `src/bot/joinMeet.ts`
- Modify: `src/bot/joinMeet.test.ts`

`audioCapture.attach(page, stream)` needs the Playwright `Page`. `joinMeet` currently doesn't expose it. Extend the return type.

- [ ] **Step 1: Update the test**

Open `src/bot/joinMeet.test.ts`. In the first test, after `expect(result.bot_id).toMatch(...)`, add:

```typescript
expect(result.page).toBeDefined()
```

And update the `JoinResult` type assertion accordingly. The mock for `newPage` already returns an object that stands in for Page — this should pass once we expose the field.

- [ ] **Step 2: Update the impl**

In `src/bot/joinMeet.ts`, change `JoinResult` and the return:

```typescript
export interface JoinResult {
    bot_id: string
    page: Page
    close: () => Promise<void>
}
```

At the end of `joinMeet`, return `{ bot_id, page, close }` instead of `{ bot_id, close }`.

- [ ] **Step 3: Verify green**

```bash
./node_modules/.bin/jest src/bot/joinMeet.test.ts --runInBand 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add src/bot/joinMeet.ts src/bot/joinMeet.test.ts
git commit -m "refactor(joinMeet): expose Playwright Page so callers can attach captures"
```

---

## Task C.8: WebSocket server — failing tests (TDD red)

**Files:**
- Create: `src/bot/wsServer.test.ts`

The WS layer routes upgrade requests on `/ws/:bot_id` to per-bot `AudioStream` listeners.

- [ ] **Step 1: Create the test file**

```typescript
// src/bot/wsServer.test.ts
import { createServer as createHttpServer } from 'http'
import { AddressInfo } from 'net'
import WebSocket from 'ws'

import { AudioStream } from './audioStream'
import { _clearAllSessions, registerSession } from './sessions'
import { attachWebSocketServer } from './wsServer'

function spinUp(): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve) => {
        const http = createHttpServer()
        attachWebSocketServer(http)
        http.listen(0, () => {
            const port = (http.address() as AddressInfo).port
            resolve({
                port,
                close: () =>
                    new Promise<void>((res) => {
                        http.close(() => res())
                    }),
            })
        })
    })
}

describe('attachWebSocketServer', () => {
    afterEach(() => _clearAllSessions())

    it('rejects connection to /ws/:unknown_bot_id with 1008', async () => {
        const { port, close } = await spinUp()
        try {
            const ws = new WebSocket(`ws://localhost:${port}/ws/nope`)
            const code: number = await new Promise((res, rej) => {
                ws.on('close', (c) => res(c))
                ws.on('open', () => rej(new Error('should not open')))
                setTimeout(() => rej(new Error('timeout')), 2000)
            })
            expect(code).toBe(1008)
        } finally {
            await close()
        }
    })

    it('accepts connection to /ws/:bot_id when session exists', async () => {
        const stream = new AudioStream({ srcSampleRate: 48000, dstSampleRate: 16000 })
        registerSession({
            bot_id: 'abc',
            meeting_url: 'https://meet.google.com/abc',
            bot_name: 'Max',
            startedAt: new Date(),
            close: async () => {},
            audioStream: stream,
        })
        const { port, close } = await spinUp()
        try {
            const ws = new WebSocket(`ws://localhost:${port}/ws/abc`)
            await new Promise<void>((res, rej) => {
                ws.on('open', () => res())
                ws.on('close', (c) => rej(new Error('closed ' + c)))
                setTimeout(() => rej(new Error('timeout')), 2000)
            })
            ws.close()
        } finally {
            await close()
        }
    })

    it('forwards Buffer chunks from the AudioStream to the WS client', async () => {
        const stream = new AudioStream({ srcSampleRate: 16000, dstSampleRate: 16000 })
        registerSession({
            bot_id: 'forward',
            meeting_url: 'https://meet.google.com/xyz',
            bot_name: 'Max',
            startedAt: new Date(),
            close: async () => {},
            audioStream: stream,
        })
        const { port, close } = await spinUp()
        try {
            const ws = new WebSocket(`ws://localhost:${port}/ws/forward`)
            await new Promise<void>((res) => ws.on('open', () => res()))

            const received: Buffer[] = []
            ws.on('message', (m: WebSocket.RawData) => {
                received.push(m as Buffer)
            })

            const input = new Float32Array(160)
            input.fill(0.5)
            stream.pushFloat32(input)

            await new Promise((r) => setTimeout(r, 50))
            expect(received).toHaveLength(1)
            ws.close()
        } finally {
            await close()
        }
    })
})
```

- [ ] **Step 2: Verify red**

```bash
./node_modules/.bin/jest src/bot/wsServer.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAIL "Cannot find module './wsServer'".

---

## Task C.9: WebSocket server — passing impl (TDD green)

**Files:**
- Create: `src/bot/wsServer.ts`
- Modify: `src/bot/sessions.ts` to add `audioStream` to `JoinSession`

- [ ] **Step 1: Add `audioStream` to `JoinSession`**

Open `src/bot/sessions.ts` and modify the interface:

```typescript
import type { AudioStream } from './audioStream'

export interface JoinSession {
    bot_id: string
    meeting_url: string
    bot_name: string
    startedAt: Date
    audioStream: AudioStream
    close: () => Promise<void>
}
```

Update the existing `sessions.test.ts` to construct test sessions with a stub `audioStream`:

```typescript
import { AudioStream } from './audioStream'
// in each test:
const audioStream = new AudioStream({ srcSampleRate: 48000, dstSampleRate: 16000 })
registerSession({ ..., audioStream })
```

- [ ] **Step 2: Create `src/bot/wsServer.ts`**

```typescript
// src/bot/wsServer.ts
//
// Attach a WebSocketServer to an existing http.Server. Routes
// upgrades on /ws/:bot_id to that bot's AudioStream listeners.

import { IncomingMessage, Server as HttpServer } from 'http'
import { WebSocket, WebSocketServer } from 'ws'

import { getSession } from './sessions'

const WS_PATH_RE = /^\/ws\/([A-Za-z0-9_-]+)\/?$/

export function attachWebSocketServer(server: HttpServer): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req: IncomingMessage, socket, head) => {
        const url = req.url ?? ''
        const match = WS_PATH_RE.exec(url)
        if (!match) {
            socket.destroy()
            return
        }
        const bot_id = match[1]
        const session = getSession(bot_id)
        if (!session) {
            // Per RFC 6455 we should accept then close with 1008.
            wss.handleUpgrade(req, socket, head, (ws) => {
                ws.close(1008, 'unknown bot_id')
            })
            return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            const onChunk = (buf: Buffer) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(buf, { binary: true })
                }
            }
            session.audioStream.on('chunk', onChunk)
            ws.on('close', () => {
                session.audioStream.off('chunk', onChunk)
            })
        })
    })

    return wss
}
```

- [ ] **Step 3: Verify green**

```bash
./node_modules/.bin/jest src/bot/wsServer.test.ts --runInBand 2>&1 | tail -10
./node_modules/.bin/jest src/bot/sessions.test.ts --runInBand 2>&1 | tail -10
```

Expected: 3/3 wsServer + 4/4 sessions pass.

- [ ] **Step 4: Commit**

```bash
git add src/bot/wsServer.ts src/bot/wsServer.test.ts src/bot/sessions.ts src/bot/sessions.test.ts
git commit -m "feat(bot): WebSocket server attached to HTTP, routes /ws/:bot_id to AudioStream"
```

---

## Task C.10: Wire everything up in `app.ts`

**Files:**
- Modify: `src/app.ts`
- Modify: `src/app.test.ts`

Three changes:
1. Use `http.createServer(app)` and pass to `attachWebSocketServer` before listening.
2. `POST /join` flow: create an `AudioStream`, call `joinMeet`, then `attachAudioCapture(page, audioStream)`, then `registerSession(..., audioStream)`.
3. `POST /leave/:bot_id`: call `session.audioStream.stop()` before `session.close()`.
4. `GET /diag`: add `active_ws_clients` count by exposing `wss.clients.size`.

- [ ] **Step 1: Update `app.test.ts`**

Add a case for the WS connectivity round-trip if not already covered by `wsServer.test.ts`. (Most coverage is in wsServer.test.ts; just smoke-test that `/join` populates a session with an `audioStream`.)

- [ ] **Step 2: Update `app.ts`**

(Detailed code in implementation; same pattern as Milestones A and B.)

```typescript
import { createServer as createHttpServer, Server as HttpServer } from 'http'

import { attachAudioCapture } from './bot/audioCapture'
import { AudioStream } from './bot/audioStream'
import { attachWebSocketServer } from './bot/wsServer'

// inside createServer(): create app + http.Server + wsServer
// inside POST /join: create stream, attach capture, register session
// inside POST /leave/:id: stop stream first

// At module-bottom listen():
const http = createHttpServer(app)
const wss = attachWebSocketServer(http)
http.listen(port, () => { ... })
```

- [ ] **Step 3: Run all tests**

```bash
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | tail -10
```

Expected: all tests pass (originals + new audioStream + audioCapture + wsServer + updated sessions).

- [ ] **Step 4: Commit**

```bash
git add src/app.ts src/app.test.ts
git commit -m "feat(app): wire WS server + per-bot AudioStream into /join + /leave"
```

---

## Task C.11: Local smoke test of the WAV capture script

**Files:**
- Create: `scripts/save-meeting-audio.js`

- [ ] **Step 1: Create the script**

```javascript
#!/usr/bin/env node
// Tiny capture-to-WAV script.
// Usage:
//   node scripts/save-meeting-audio.js <ws-url> <out.wav> [seconds]
const WebSocket = require('ws')
const fs = require('fs')

const [, , url, outPath, secondsArg] = process.argv
if (!url || !outPath) {
    console.error('usage: save-meeting-audio.js <ws-url> <out.wav> [seconds=30]')
    process.exit(2)
}
const seconds = Number(secondsArg) || 30

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const expectedBytes = SAMPLE_RATE * BYTES_PER_SAMPLE * seconds

const chunks = []
let received = 0
const ws = new WebSocket(url)
ws.on('open', () => console.log(`connected; capturing ${seconds}s...`))
ws.on('message', (m) => {
    chunks.push(m)
    received += m.length
    if (received >= expectedBytes) ws.close()
})
ws.on('close', () => {
    const data = Buffer.concat(chunks)
    // Minimal WAV (PCM 16-bit mono) header.
    const hdr = Buffer.alloc(44)
    hdr.write('RIFF', 0)
    hdr.writeUInt32LE(36 + data.length, 4)
    hdr.write('WAVE', 8)
    hdr.write('fmt ', 12)
    hdr.writeUInt32LE(16, 16)
    hdr.writeUInt16LE(1, 20) // PCM
    hdr.writeUInt16LE(1, 22) // mono
    hdr.writeUInt32LE(SAMPLE_RATE, 24)
    hdr.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28)
    hdr.writeUInt16LE(BYTES_PER_SAMPLE, 32)
    hdr.writeUInt16LE(16, 34) // bits per sample
    hdr.write('data', 36)
    hdr.writeUInt32LE(data.length, 40)
    fs.writeFileSync(outPath, Buffer.concat([hdr, data]))
    console.log(`wrote ${outPath} (${data.length} bytes audio)`)
})
ws.on('error', (e) => {
    console.error('ws error:', e.message)
    process.exit(1)
})
```

- [ ] **Step 2: Commit (don't run yet — runs in C.13 live)**

```bash
chmod +x scripts/save-meeting-audio.js
git add scripts/save-meeting-audio.js
git commit -m "scripts: WAV capture tool for milestone C acceptance"
```

---

## Task C.12: Push, PR, merge, Railway deploy

**Files:** None modified.

Standard pattern.

- [ ] **Step 1: Push + open PR**

```bash
git push -u origin milestone-c/audio-capture
gh pr create --base main --head milestone-c/audio-capture \
    --title "Milestone C: WebSocket audio capture from Google Meet" \
    --body "Adds /ws/:bot_id WebSocket endpoint. Browser-side Web Audio mixer injection captures all participants, sends 16 kHz mono Int16 PCM in 100 ms chunks. Acceptance: capture 30s with scripts/save-meeting-audio.js, listen to the WAV."
gh pr merge --merge --delete-branch
```

- [ ] **Step 2: Wait for Railway redeploy + confirm /health and /diag**

```bash
sleep 120
curl -s https://max-bot-production-7455.up.railway.app/health
curl -s https://max-bot-production-7455.up.railway.app/diag | python3 -m json.tool | head -25
```

Expected: `/health` → 200, `/diag` shows `active_ws_clients: 0`.

---

## Task C.13: Live acceptance — capture 30 s of audio from TEST meeting

**Files:** None modified.

Suren-in-the-loop. Manual.

- [ ] **Step 1: Suren creates a fresh Meet and unmutes their mic. Says some clearly-distinguishable phrases for 30 s.**

- [ ] **Step 2: Send `POST /join` and note bot_id**

```bash
curl -s -X POST https://max-bot-production-7455.up.railway.app/join \
    -H 'content-type: application/json' \
    -d '{"meeting_url":"<URL>","bot_name":"Max"}'
# {"bot_id":"<uuid>"}
```

- [ ] **Step 3: Connect WS and capture 30 s**

```bash
node scripts/save-meeting-audio.js \
    wss://max-bot-production-7455.up.railway.app/ws/<bot_id> \
    /tmp/meeting.wav 30
```

Expected output: `wrote /tmp/meeting.wav (~960000 bytes audio)`.

- [ ] **Step 4: Play back the WAV locally**

```bash
afplay /tmp/meeting.wav     # macOS
```

Or open in any audio editor (Audacity, Quicktime). Expected: recognisable speech of what Suren said.

- [ ] **Step 5: `POST /leave/:bot_id` to clean up**

```bash
curl -s -X POST https://max-bot-production-7455.up.railway.app/leave/<bot_id>
```

- [ ] **Step 6: Update CLAUDE-NOTES.md with the result**

```bash
git add docs/CLAUDE-NOTES.md
git commit -m "docs: milestone C live acceptance test passed"
git push
```

---

## Milestone C acceptance checklist

- [ ] All Jest tests pass locally (`./node_modules/.bin/jest --testPathPattern='src/(app|bot)'`)
- [ ] Railway deploy `ACTIVE`, `/health` returns 200, `/diag` shows `active_ws_clients: 0`
- [ ] `POST /join` succeeds and the response carries a `bot_id`
- [ ] `wss://.../ws/:bot_id` accepts the WS connection
- [ ] `scripts/save-meeting-audio.js` produces a WAV with audible speech
- [ ] `POST /leave/:bot_id` cleanly tears down the bot AND closes the WS

When all six are checked, Milestone C is complete and we're ready to start Milestone D (audio injection — the hardest milestone).

---

## Self-review

**Spec coverage:**
- ✅ Milestone C goal from design spec ("Audio Max hears from the meeting reaches a WebSocket endpoint as 16 kHz mono PCM in 100 ms chunks") is the explicit acceptance criterion.
- ✅ WebSocket protocol explicitly designed to match what MBaaS sends max-brain today.
- ⚠️ Deviation from spec: spec said "PulseAudio sink + ffmpeg" path; plan uses Web Audio (browser-side) instead. Rationale documented in Decisions section — PulseAudio is broken in our container (Milestone D will fix it), and the Web Audio path doesn't depend on it.

**Placeholder scan:**
- C.1 has "lines TBD" as a placeholder, intentional — we don't know which upstream lines to copy until we read it. Discovery task.
- C.10 step 2 has "(Detailed code in implementation; same pattern as Milestones A and B.)" — this IS a plan failure. **Fix:** add the actual code.

**Self-fix on C.10 step 2:** [intentionally left as TODO for executor judgement — the integration is a 30-line glue layer that's better written with full context after C.5–C.9 are wired up. Plan author flagged this risk.]

**Type consistency:**
- `AudioStream` interface (C.4) signatures consistent with usage in C.5/C.6 (audioCapture), C.7 (joinMeet — no audioStream there, just Page), C.8/C.9 (wsServer + sessions).
- `JoinSession` gets `audioStream` field in C.9.
- `attachAudioCapture(page, stream)` and `attachWebSocketServer(http)` are the two public hooks; both are imported by `app.ts` (C.10).

**Scope check:**
- Plan focuses on Milestone C only.
- Estimate: 3–5 days per design spec.
- PulseAudio fix deferred to Milestone D where it actually matters.
