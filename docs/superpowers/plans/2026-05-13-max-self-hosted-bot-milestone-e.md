# Max Self-Hosted Bot — Milestone E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suren runs `curl -X POST https://max-brain-production.up.railway.app/join -d '{meeting_url, bot_name}'` and within 30 seconds is having a real spoken conversation with Max in the Google Meet — Max hears Suren, processes via Pipecat (Deepgram STT → Claude Haiku 4.5 LLM → Deepgram TTS), and speaks back through Max's mic. Equivalent to V1.4 behaviour, but with max-bot replacing MBaaS as the bot layer.

**Architecture:** max-bot becomes a "MBaaS-shaped WebSocket client" for max-brain. max-brain keeps its existing `/ws/{bot_id}` server interface unchanged — it has no idea anything has changed at the WS layer. max-brain's `/join` handler is the only code change there: it calls `${BOT_SERVICE_URL}/join` instead of `https://api.meetingbaas.com/v2/bots`, with a stripped-down request body. max-bot's `/join` accepts the request, launches Playwright, and ALSO opens an outbound WS connection to max-brain's `/ws/{bot_id}` — bridging captured Meet audio (out) and TTS audio (in) over that single connection, byte-for-byte identical to MBaaS's protocol.

**Tech Stack:** TypeScript (max-bot), Python (max-brain), `ws` package, Railway hosting for both services.

**Pre-conditions in place:**
- Milestone D v2 is shipped (commit `4ff7df8` on `main` in `suren-pm/max-bot`). `/ws/:bot_id` capture + `/ws_in/:bot_id` injection both verified working with no echo loopback.
- `https://max-bot-production-7455.up.railway.app/health` returns 200.
- max-brain code is at commit `2082cbd` in `suren-pm/max-brain` repo (locally cloned at `~/Documents/Claude/Max AI Employee/`).
- max-brain's `/ws/{bot_id}` handler expects binary frames of 16 kHz mono 16-bit PCM as input AND sends binary frames in the same format as output (verified in `max/server.py:635-729`).
- max-brain service is currently PAUSED on Railway project `sincere-grace` (no active deployment, no compute charges).

**What ships at end of Milestone E:**
- New module `src/bot/maxBrainBridge.ts` in max-bot — opens outbound WS to max-brain, bridges audio in/out
- max-bot `/join` handler launches both Playwright AND the bridge per session
- max-brain `/join` handler calls max-bot's API instead of MBaaS
- `MAX_BRAIN_WS_URL` env var on max-bot Railway service
- `BOT_SERVICE_URL` env var on max-brain Railway service
- max-brain unpaused on Railway, serving traffic
- Live verification: Suren has a coherent ~1-minute conversation with Max in the TEST meeting via the new stack

**Out of scope for E:**
- Hardening for 30+ min sessions, auto-restart on crash (Milestone F)
- Sliding context window on max-brain to fix the V1.4 long-session degradation (Phase 2)
- Real Google Workspace account / anti-bot detection (Phase 2)
- Microsoft Teams support (Phase 2)

---

## What this plan does NOT do (deliberately)

- **Does NOT change max-brain's `/ws/{bot_id}` WebSocket server interface.** Per design spec section 3, the protocol stays byte-identical so max-brain is a "drop-in replacement target". max-bot adapts to max-brain, not the reverse.
- **Does NOT use max-bot's existing `/ws/:bot_id` or `/ws_in/:bot_id` endpoints from max-brain side.** Those exist for ad-hoc testing (like `scripts/save-meeting-audio.js`). For the real integration, max-bot connects OUT to max-brain.
- **Does NOT remove `MEETING_BAAS_API_KEY` from max-brain's env yet.** Per spec section 9, it stays as inactive fallback for rollback safety.
- **Does NOT touch max-brain's Pipecat pipeline.** Only the `/join` handler changes.

---

## File Structure

### max-bot repo (`~/Documents/Claude/max-bot`)

| File | Action | Purpose |
|---|---|---|
| `src/bot/maxBrainBridge.ts` | Create | WebSocket CLIENT that connects to max-brain's `/ws/{bot_id}`. Subscribes to AudioStream `chunk` events and sends each binary chunk via `ws.send`. Receives binary frames via `ws.on('message')` and pushes them to AudioInject. Handles reconnect with exponential backoff. |
| `src/bot/maxBrainBridge.test.ts` | Create | Jest + mock WS server tests: connect, audio bridge in/out, reconnect on disconnect, stop() cleanup. |
| `src/bot/sessions.ts` | Modify | Add `maxBrainBridge: MaxBrainBridge` field to `JoinSession`. |
| `src/bot/sessions.test.ts` | Modify | Stub MaxBrainBridge in test session constructors. |
| `src/bot/wsServer.test.ts` | Modify | Same stub. |
| `src/app.ts` | Modify | `/join` constructs MaxBrainBridge after AudioStream + AudioInject, passes bridge URL from `MAX_BRAIN_WS_URL` env. `/leave` stops the bridge first. `/diag` includes bridge connection state. |
| `src/app.test.ts` | Modify | Mock MaxBrainBridge construction. |

### max-brain repo (`~/Documents/Claude/Max AI Employee`)

| File | Action | Purpose |
|---|---|---|
| `max/server.py` | Modify | `/join` handler (lines 823-901): replace MBaaS API call with POST to `${BOT_SERVICE_URL}/join`. Strip MBaaS-specific request fields (`bot_image`, `recording_mode`, `transcription_enabled`, `no_one_joined_timeout`, `waiting_room_timeout`, `streaming_enabled`, `streaming_config`, `extra`). Keep only `{meeting_url, bot_name}`. Remove `x-meeting-baas-api-key` header. |

### Railway projects

| Project | Service | Action | Env vars |
|---|---|---|---|
| `max-self-hosted` | `max-bot` | Add env var | `MAX_BRAIN_WS_URL=wss://max-brain-production.up.railway.app/ws` |
| `sincere-grace` | `max-brain` | Un-pause + add env | `BOT_SERVICE_URL=https://max-bot-production-7455.up.railway.app` |

**Deliberately NOT touched:** max-brain's `/ws/{bot_id}` handler, Pipecat pipeline, persona, voice, anything related to the audio processing chain.

---

## Decisions locked in for E

- **max-bot is the WS client, max-brain is the WS server.** Direction matches MBaaS-to-max-brain pattern today. Keeps max-brain's existing handler unchanged.
- **One WS connection per bot session.** Same connection handles both directions (capture out from max-bot to max-brain, TTS in from max-brain to max-bot). Mirrors MBaaS's single-connection-per-bot pattern.
- **Binary frames only.** No JSON envelope, no base64. max-brain's handler already accepts both binary and base64, but binary is what MBaaS uses and what we already produce in audioStream.
- **Reconnect on disconnect.** If the WS drops mid-session, exponential backoff retry up to 5 attempts. Don't lose audio capture during a transient hiccup.
- **`MAX_BRAIN_WS_URL` is a base URL.** Per-bot path is appended: `${MAX_BRAIN_WS_URL}/${bot_id}`. So env value is `wss://max-brain-production.up.railway.app/ws` (no trailing `/`, no `{bot_id}`).
- **Both env vars set via Railway dashboard.** No code commits the URLs — they're per-environment.

---

## Pre-work — branch setup

### Task E.0: Branch from main on max-bot

**Files:** None modified.

- [ ] **Step 1: Pull latest main + branch**

```bash
cd ~/Documents/Claude/max-bot
git checkout main
git pull origin main
git checkout -b milestone-e/max-brain-bridge
```

- [ ] **Step 2: Verify Node + jest + baseline**

```bash
unset NODE_ENV
source ~/.nvm/nvm.sh && nvm use 20
node --version
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | grep -E "Tests:|FAIL" | head -3
```

Expected: `Tests: 38 passed, 38 total`. If failures, stop and report — don't proceed until baseline is green.

- [ ] **Step 3: Verify max-bot production health**

```bash
curl -s -w "HTTP %{http_code}\n" https://max-bot-production-7455.up.railway.app/health
```

Expected: HTTP 200, JSON payload with `version: 0.1.0`.

---

## Task E.1: MaxBrainBridge module — failing tests (TDD red)

**Files:**
- Create: `src/bot/maxBrainBridge.test.ts`

Tests use a real WebSocketServer (the `ws` package) spun up on a random port to act as a fake max-brain. The bridge connects to it, audio flows in both directions.

- [ ] **Step 1: Create the test file**

```typescript
// src/bot/maxBrainBridge.test.ts
import { AddressInfo } from 'net'

import { WebSocketServer, WebSocket } from 'ws'

import { AudioStream } from './audioStream'
import { MaxBrainBridge } from './maxBrainBridge'

function spinUpFakeBrain(): Promise<{
    wss: WebSocketServer
    port: number
    close: () => Promise<void>
}> {
    return new Promise((resolve) => {
        const wss = new WebSocketServer({ port: 0 })
        wss.on('listening', () => {
            const port = (wss.address() as AddressInfo).port
            resolve({
                wss,
                port,
                close: () =>
                    new Promise<void>((res) => {
                        wss.close(() => res())
                    }),
            })
        })
    })
}

describe('MaxBrainBridge', () => {
    it('connects to ${wsUrl}/${bot_id} on construction', async () => {
        const env = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const inject = {
            pushInt16Buffer: jest.fn(),
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        const connectPromise = new Promise<string>((resolve) => {
            env.wss.on('connection', (_ws, req) => {
                resolve(req.url ?? '')
            })
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env.port}`,
            botId: 'test-bot-id',
            audioStream: stream,
            audioInject: inject as never,
        })

        const url = await connectPromise
        expect(url).toBe('/test-bot-id')

        bridge.stop()
        await env.close()
    })

    it('forwards AudioStream chunks to the WebSocket as binary frames', async () => {
        const env = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const inject = {
            pushInt16Buffer: jest.fn(),
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        const received: Buffer[] = []
        env.wss.on('connection', (ws) => {
            ws.on('message', (m: Buffer) => {
                received.push(m)
            })
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env.port}`,
            botId: 'bot-fwd',
            audioStream: stream,
            audioInject: inject as never,
        })

        // Wait for connection to open
        await new Promise((r) => setTimeout(r, 100))

        // Push some audio through AudioStream
        const input = new Float32Array(160)
        input.fill(0.5)
        stream.pushFloat32(input)

        await new Promise((r) => setTimeout(r, 100))
        expect(received).toHaveLength(1)
        expect(received[0].length).toBe(160 * 2) // 160 samples × 2 bytes Int16

        bridge.stop()
        await env.close()
    })

    it('forwards incoming WebSocket binary frames to AudioInject.pushInt16Buffer', async () => {
        const env = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const pushMock = jest.fn()
        const inject = {
            pushInt16Buffer: pushMock,
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        let serverWs: WebSocket | null = null
        env.wss.on('connection', (ws) => {
            serverWs = ws
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env.port}`,
            botId: 'bot-recv',
            audioStream: stream,
            audioInject: inject as never,
        })

        // Wait for connection to be accepted server-side
        await new Promise((r) => setTimeout(r, 100))
        expect(serverWs).not.toBeNull()

        // Server sends bytes to client
        const payload = Buffer.alloc(4)
        payload.writeInt16LE(100, 0)
        payload.writeInt16LE(200, 2)
        serverWs!.send(payload, { binary: true })

        await new Promise((r) => setTimeout(r, 100))
        expect(pushMock).toHaveBeenCalled()
        const got: Buffer = pushMock.mock.calls[0][0]
        expect(got.length).toBe(4)
        expect(got.readInt16LE(0)).toBe(100)
        expect(got.readInt16LE(2)).toBe(200)

        bridge.stop()
        await env.close()
    })

    it('stop() closes the WebSocket and stops forwarding', async () => {
        const env = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const inject = {
            pushInt16Buffer: jest.fn(),
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        let closeFired = false
        env.wss.on('connection', (ws) => {
            ws.on('close', () => {
                closeFired = true
            })
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env.port}`,
            botId: 'bot-stop',
            audioStream: stream,
            audioInject: inject as never,
        })

        await new Promise((r) => setTimeout(r, 100))
        bridge.stop()
        await new Promise((r) => setTimeout(r, 100))

        expect(closeFired).toBe(true)
        await env.close()
    })
})
```

- [ ] **Step 2: Run the test and verify red**

```bash
./node_modules/.bin/jest src/bot/maxBrainBridge.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAIL with `Cannot find module './maxBrainBridge'`.

---

## Task E.2: MaxBrainBridge — passing impl (TDD green)

**Files:**
- Create: `src/bot/maxBrainBridge.ts`

- [ ] **Step 1: Create the implementation**

```typescript
// src/bot/maxBrainBridge.ts
//
// WebSocket client that connects out to max-brain's /ws/{bot_id}
// endpoint and bridges audio in both directions:
//   - AudioStream chunks (captured Meet audio) -> ws.send (binary)
//   - ws.on('message') binary frames           -> AudioInject.pushInt16Buffer
//
// This mirrors MBaaS's WebSocket client behaviour: max-brain's
// /ws/{bot_id} server is unchanged, max-bot just plays the role
// MBaaS used to.

import { WebSocket } from 'ws'

import type { AudioInject } from './audioInject'
import type { AudioStream } from './audioStream'

export interface MaxBrainBridgeOptions {
    /** Base WS URL, e.g. wss://max-brain-production.up.railway.app/ws */
    wsUrl: string
    botId: string
    audioStream: AudioStream
    audioInject: AudioInject
}

export class MaxBrainBridge {
    private ws: WebSocket | null = null
    private stopped = false
    private readonly fullUrl: string
    private readonly audioStream: AudioStream
    private readonly audioInject: AudioInject
    private readonly onChunk: (buf: Buffer) => void
    private reconnectAttempts = 0
    private readonly maxReconnects = 5

    constructor(opts: MaxBrainBridgeOptions) {
        this.fullUrl = `${opts.wsUrl}/${opts.botId}`
        this.audioStream = opts.audioStream
        this.audioInject = opts.audioInject
        // Stable function reference so we can off() it later.
        this.onChunk = (buf: Buffer) => {
            if (
                this.ws &&
                this.ws.readyState === WebSocket.OPEN
            ) {
                this.ws.send(buf, { binary: true })
            }
        }
        this.audioStream.on('chunk', this.onChunk)
        this.connect()
    }

    private connect(): void {
        if (this.stopped) return
        try {
            this.ws = new WebSocket(this.fullUrl)
        } catch (err) {
            this.scheduleReconnect()
            return
        }

        this.ws.on('open', () => {
            this.reconnectAttempts = 0
        })

        this.ws.on('message', (m: unknown) => {
            if (m instanceof Buffer) {
                this.audioInject.pushInt16Buffer(m)
            }
        })

        this.ws.on('close', () => {
            if (!this.stopped) {
                this.scheduleReconnect()
            }
        })

        this.ws.on('error', () => {
            // Errors trigger 'close' afterwards; reconnect logic lives there.
        })
    }

    private scheduleReconnect(): void {
        if (this.stopped) return
        if (this.reconnectAttempts >= this.maxReconnects) return
        this.reconnectAttempts += 1
        const delayMs = Math.min(
            1000 * Math.pow(2, this.reconnectAttempts - 1),
            10000,
        )
        setTimeout(() => this.connect(), delayMs)
    }

    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN
    }

    stop(): void {
        if (this.stopped) return
        this.stopped = true
        this.audioStream.off('chunk', this.onChunk)
        try {
            this.ws?.close()
        } catch {
            /* ignore */
        }
    }
}
```

- [ ] **Step 2: Run the test and verify green**

```bash
./node_modules/.bin/jest src/bot/maxBrainBridge.test.ts --runInBand 2>&1 | tail -10
```

Expected: 4/4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/maxBrainBridge.ts src/bot/maxBrainBridge.test.ts
git commit -m "feat(bot): MaxBrainBridge — WS client to max-brain

Bridges AudioStream captures to outgoing WebSocket frames and
incoming WebSocket frames to AudioInject. Mirrors MBaaS pattern:
max-brain has no idea it is talking to max-bot instead of MBaaS.

4/4 tests cover connect, audio bridge each direction, stop cleanup."
```

---

## Task E.3: Add MaxBrainBridge to JoinSession + wire into app.ts (TDD)

**Files:**
- Modify: `src/bot/sessions.ts` (add field)
- Modify: `src/bot/sessions.test.ts` (stub)
- Modify: `src/bot/wsServer.test.ts` (stub)
- Modify: `src/app.ts` (construct bridge in /join, stop in /leave)
- Modify: `src/app.test.ts` (mock bridge construction)

- [ ] **Step 1: Update `JoinSession` interface**

In `src/bot/sessions.ts`, add `maxBrainBridge: MaxBrainBridge` field. The type import at the top of the file already has audioInject and audioStream — add this third import:

```typescript
// src/bot/sessions.ts — add to imports
import type { MaxBrainBridge } from './maxBrainBridge'

export interface JoinSession {
    bot_id: string
    meeting_url: string
    bot_name: string
    startedAt: Date
    audioStream: AudioStream
    audioInject: AudioInject
    maxBrainBridge: MaxBrainBridge
    page: Page
    close: () => Promise<void>
}
```

- [ ] **Step 2: Update existing test stubs**

Both `src/bot/sessions.test.ts` and `src/bot/wsServer.test.ts` construct fake sessions for tests. Add `maxBrainBridge: {} as never` to each `registerSession({...})` call in those files. The `{} as never` cast bypasses the type system for tests that don't actually exercise the bridge.

- [ ] **Step 3: Update `/join` in `src/app.ts`**

Find the `/join` handler. After `registerSession({...})` is called, the order changes to:
1. Create `AudioStream` (existing)
2. Call `joinMeet({onPageReady: ...})` (existing, attaches AudioCapture)
3. Create `AudioInject` (existing)
4. NEW: Create `MaxBrainBridge` with the bot_id, AudioStream, AudioInject
5. Register session with all of audioStream, audioInject, maxBrainBridge, page, close

Specifically inside the try block of `/join`:

```typescript
// near top of file, with other imports
import { MaxBrainBridge } from './bot/maxBrainBridge'

// inside /join handler, after AudioInject creation, before registerSession:
const maxBrainWsUrl = process.env.MAX_BRAIN_WS_URL
const maxBrainBridge = new MaxBrainBridge({
    wsUrl: maxBrainWsUrl ?? 'ws://localhost:0',
    botId: bot_id,
    audioStream,
    audioInject,
})

registerSession({
    bot_id,
    meeting_url,
    bot_name,
    startedAt: new Date(),
    audioStream,
    audioInject,
    maxBrainBridge,
    page,
    close: async () => {
        maxBrainBridge.stop()
        audioStream.stop()
        audioInject.stop()
        await close()
    },
})
```

When `MAX_BRAIN_WS_URL` is unset (local tests / pre-E.7 deploy), bridge attempts to connect to `ws://localhost:0/${bot_id}` and fails harmlessly — reconnect backoff kicks in, no effect on the rest of /join.

- [ ] **Step 4: Update `app.test.ts` to mock MaxBrainBridge**

The test file already mocks `child_process` for AudioInject. Add a Jest mock for `./bot/maxBrainBridge` at the top of `src/app.test.ts`, ABOVE the `import { createServer }` line:

```typescript
jest.mock('./bot/maxBrainBridge', () => {
    return {
        MaxBrainBridge: jest.fn().mockImplementation(() => ({
            stop: jest.fn(),
            isConnected: jest.fn(() => false),
        })),
    }
})
```

- [ ] **Step 5: Run full suite as regression**

```bash
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | grep -E "Tests:|FAIL" | head -3
```

Expected: `Tests: 42 passed, 42 total` (38 baseline + 4 new MaxBrainBridge).

- [ ] **Step 6: Commit**

```bash
git add src/bot/sessions.ts src/bot/sessions.test.ts \
        src/bot/wsServer.test.ts \
        src/app.ts src/app.test.ts
git commit -m "feat(app): construct MaxBrainBridge per /join, stop on /leave

JoinSession gains a maxBrainBridge field. /join reads
MAX_BRAIN_WS_URL env (when unset, bridge harmlessly retries
ws://localhost:0 and stays disconnected — does not affect the
rest of the join flow). /leave stops the bridge first.

42/42 tests pass."
```

---

## Task E.4: Push, PR, merge, deploy max-bot

**Files:** None modified.

- [ ] **Step 1: Push + open PR**

```bash
git push -u origin milestone-e/max-brain-bridge
gh pr create --base main --head milestone-e/max-brain-bridge \
    --title "Milestone E: max-bot becomes WS client to max-brain" \
    --body "Adds MaxBrainBridge module. Each /join opens an outbound WebSocket to max-brain at \${MAX_BRAIN_WS_URL}/\${bot_id} and bridges audio in both directions. max-brain's existing /ws/{bot_id} server is unchanged — max-bot mimics MBaaS's client pattern.

When MAX_BRAIN_WS_URL env is unset, bridge fails to connect harmlessly (backoff retry) — won't affect existing /ws/:bot_id or /ws_in/:bot_id ad-hoc test endpoints."
gh pr merge --merge --delete-branch
git checkout main
git pull --rebase origin main
```

- [ ] **Step 2: Wait for Railway redeploy + verify /health**

```bash
echo "current UTC: $(date -u)"
sleep 130
curl -s -w "HTTP %{http_code}\n" https://max-bot-production-7455.up.railway.app/health
```

Expected: HTTP 200.

- [ ] **Step 3: Verify the new build is live**

```bash
curl -s https://max-bot-production-7455.up.railway.app/diag | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('startsh timestamp:', d['startsh_present'][:80])
print('version:', d.get('version'))
"
```

`startsh timestamp` should be NEW (after `05:34 May 13` — that's D v2's deploy). If the same, Railway hasn't redeployed yet — wait another 60s and re-check.

---

## Task E.5: Set `MAX_BRAIN_WS_URL` env var on max-bot Railway

**Files:** None modified (Railway dashboard work).

- [ ] **Step 1: Open Railway dashboard for max-bot**

URL: `https://railway.com/project/1905056d-e126-4dad-8f3c-ed26bcbe720e/service/791b4c57-160b-4192-8981-3285081f81da?environmentId=5072ab9a-6cc0-4aed-9294-9845c4221334`

Navigate to: max-bot service → Variables tab → New Variable.

- [ ] **Step 2: Add the variable**

- Name: `MAX_BRAIN_WS_URL`
- Value: `wss://max-brain-production.up.railway.app/ws`

NOTE: This URL assumes max-brain's Railway domain stays the same as before pausing. If max-brain gets a different domain after unpause (Task E.7), come back and update this value. The `/ws` at the end is critical — `MaxBrainBridge` appends `/${bot_id}` so the full URL becomes `wss://max-brain.../ws/${bot_id}` matching max-brain's `@app.websocket("/ws/{bot_id}")` route.

- [ ] **Step 3: Railway auto-redeploys when env vars change**

```bash
echo "current UTC: $(date -u)"
sleep 60
curl -s -w "HTTP %{http_code}\n" https://max-bot-production-7455.up.railway.app/health
```

Expected: HTTP 200. The env-var-change redeploy is fast (~60s, no Docker rebuild).

---

## Task E.6: Modify max-brain `/join` handler

**Files:**
- Modify: `~/Documents/Claude/Max AI Employee/max/server.py` (lines 823-901)

- [ ] **Step 1: Branch in max-brain repo**

```bash
cd ~/Documents/Claude/Max\ AI\ Employee
git status
git checkout main
git pull origin main 2>&1 | tail -2
git checkout -b milestone-e/call-max-bot
```

- [ ] **Step 2: Replace the `/join` handler body**

Open `max/server.py`. The handler currently spans lines 823-901. Replace the entire function with this minimal version:

```python
@app.post("/join")
async def join_meeting(request: Request):
    """Trigger Max to join a Google Meet via max-bot (self-hosted)."""
    body = await request.json()
    meeting_url = body.get("meeting_url") or os.getenv("GOOGLE_MEET_URL", "")
    bot_name = body.get("bot_name", "Max")

    if not meeting_url:
        return {"error": "meeting_url required (or set GOOGLE_MEET_URL env var)"}

    # max-bot (self-hosted). When max-bot's /join succeeds, max-bot opens
    # an outbound WS to OUR /ws/{bot_id} endpoint and starts streaming
    # captured audio in. The bot_id is generated by max-bot.
    bot_service_url = os.getenv("BOT_SERVICE_URL", "")
    if not bot_service_url:
        return {"error": "BOT_SERVICE_URL not set"}

    payload = {
        "meeting_url": meeting_url,
        "bot_name":    bot_name,
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{bot_service_url}/join",
            headers={"Content-Type": "application/json"},
            json=payload,
            timeout=60,
        )

    if resp.status_code == 200:
        result = resp.json()
        bot_id = result.get("bot_id") or "unknown"
        alog(f"JOIN OK — max-bot bot_id={bot_id}")
        return {"ok": True, "bot_id": bot_id, "meeting_url": meeting_url}

    logger.error(f"max-bot {resp.status_code}: {resp.text[:200]}")
    return {"error": f"max-bot {resp.status_code}", "detail": resp.text[:200]}
```

Notes:
- Removed: `bot_image`, `recording_mode`, `transcription_enabled`, `no_one_joined_timeout`, `waiting_room_timeout`, `streaming_enabled`, `streaming_config`, `extra`, `MEETING_BAAS_API_KEY` header, `RAILWAY_PUBLIC_DOMAIN` derivation, `ws_url` construction
- Kept: meeting_url + bot_name + error handling structure
- Net effect: ~75 lines of MBaaS-specific code gone, ~30 lines of much simpler code remain

- [ ] **Step 3: Verify nothing else in max/server.py references the old MBaaS endpoint**

```bash
grep -n "MEETING_BAAS\|meetingbaas\|api\.meetingbaas\|/v2/bots" max/server.py
```

The `MEETING_BAAS_API` constant at the top of the file (line 82) and similar references are still there for historical/fallback reasons. Per the design spec section 9, we keep them as inactive fallback. Don't remove them in this milestone.

- [ ] **Step 4: Commit + push max-brain branch**

```bash
git add max/server.py
git commit -m "feat(join): route through self-hosted max-bot

/join now POSTs to \${BOT_SERVICE_URL}/join with a minimal body
{meeting_url, bot_name}. max-bot returns the bot_id; max-bot also
opens an outbound WebSocket to our /ws/{bot_id} server endpoint
to stream audio. Our /ws/{bot_id} handler is unchanged.

Removed MBaaS-specific request fields: bot_image, recording_mode,
transcription_enabled, no_one_joined_timeout, waiting_room_timeout,
streaming_enabled, streaming_config, extra. MEETING_BAAS_API_KEY
no longer sent.

Constants at module-top retained for fallback (per design spec
section 9, allows quick revert if max-bot has issues during demo)."
git push -u origin milestone-e/call-max-bot
```

- [ ] **Step 5: Open + merge PR**

```bash
gh pr create --base main --head milestone-e/call-max-bot \
    --title "Milestone E: route /join through self-hosted max-bot" \
    --body "Replaces MBaaS call with POST to \${BOT_SERVICE_URL}/join. ~70 lines removed, ~25 added."
gh pr merge --merge --delete-branch
git checkout main
git pull --rebase origin main
```

---

## Task E.7: Un-pause max-brain on Railway + add `BOT_SERVICE_URL` env

**Files:** None modified (Railway dashboard work).

- [ ] **Step 1: Open Railway dashboard for max-brain**

Navigate to the `sincere-grace` Railway project → max-brain service.

The service currently shows *"There is no active deployment for this service."* per the project memory file.

- [ ] **Step 2: Add `BOT_SERVICE_URL` env var BEFORE redeploying**

- Service → Variables tab → New Variable
- Name: `BOT_SERVICE_URL`
- Value: `https://max-bot-production-7455.up.railway.app`

(No trailing slash. max-brain's new /join handler appends `/join` to it.)

- [ ] **Step 3: Trigger deployment of latest main**

Service → Deployments tab → "Deploy" button (or "Deploy the repo suren-pm/max-brain").

Wait for build + healthcheck. ~3-5 minutes for max-brain (it's a Python service with deepgram/anthropic deps, but Railway caches layers).

- [ ] **Step 4: Verify max-brain is up**

```bash
# Once Railway shows the deploy ACTIVE, check the public URL
curl -s -w "HTTP %{http_code}\n" https://max-brain-production.up.railway.app/health
```

Note the exact domain — Railway may have given the service a new auto-generated subdomain after the pause. If `max-brain-production.up.railway.app` returns 404 "Application not found", we need to:
- Either find the actual current domain via Railway dashboard's Networking section
- Or generate a public domain (Settings → Networking → Generate Domain)

If a different domain is generated (e.g. `max-brain-production-XXXX.up.railway.app`), update the `MAX_BRAIN_WS_URL` env var on the max-bot service (Task E.5) to match. The actual URL is needed in BOTH places.

- [ ] **Step 5: Verify cross-service connectivity**

```bash
# Hit max-brain's /join and see it call max-bot
curl -s -X POST https://max-brain-production.up.railway.app/join \
    -H 'content-type: application/json' \
    -d '{"meeting_url":"https://meet.google.com/mmg-mjgn-njd","bot_name":"Max"}'
```

Expected: `{"ok": true, "bot_id": "<uuid>", "meeting_url": "..."}`. If 500 or error, check max-brain's deploy logs for the actual failure (most likely `BOT_SERVICE_URL not set` or HTTPX timeout).

This is the FIRST cross-service test. After this, Max should appear in the meeting.

---

## Task E.8: Verify the WebSocket bridge is actually flowing audio

**Files:** None modified.

- [ ] **Step 1: After E.7 succeeds and Max is in your meeting, check max-bot's bridge state**

```bash
# Extract bot_id from the previous join's response
BOT_ID=<paste the uuid from E.7 step 5>

# Verify the bridge connected
curl -s https://max-bot-production-7455.up.railway.app/diag | python3 -m json.tool | head -25
```

- [ ] **Step 2: Verify audio capture is still happening (Milestone C path)**

```bash
curl -s https://max-bot-production-7455.up.railway.app/diag/audio/$BOT_ID | python3 -m json.tool
```

`chunksSent` should be incrementing (lots, since Suren is in the meeting making sound).

- [ ] **Step 3: Verify audio injection is still ready (Milestone D path)**

```bash
curl -s https://max-bot-production-7455.up.railway.app/diag/inject/$BOT_ID | python3 -m json.tool
```

`ffmpeg_pid` non-null, `ffmpeg_exit_code` null.

If all three are healthy, the bridge is the only remaining unknown.

---

## Task E.9: Live acceptance — Suren has a conversation with Max

**Files:** None modified.

Suren-in-the-loop. The whole point of Phase 1.

- [ ] **Step 1: Confirm Max is in the meeting**

Suren should already see Max in the participants panel from Task E.7 step 5.

- [ ] **Step 2: Speak to Max**

Try:
- "Hey Max, can you hear me?"
- "Max, what's your name?"
- "Max, introduce yourself."

Within ~2-5 seconds (matching V1.4's latency floor — see memory `project_max_latency_floor.md`), Max should respond verbally.

- [ ] **Step 3: Have a 30-60 second conversation**

Verify:
- (a) Max hears Suren and responds (capture path works through max-brain pipeline)
- (b) Max's voice plays in the meeting (injection path works)
- (c) No echo of Suren's voice through Max (the D v2 fix is still in effect)
- (d) Latency feels comparable to V1.4 (~1-2 seconds for simple turns)
- (e) Max's persona is intact (Maxine, Aussie female, professional)

- [ ] **Step 4: Tear down**

```bash
curl -X POST https://max-bot-production-7455.up.railway.app/leave/$BOT_ID
```

(Note: max-brain's /leave can be added later; for now we use max-bot's directly since it controls the actual session.)

- [ ] **Step 5: Update CLAUDE-NOTES.md in max-bot repo**

Append to `~/Documents/Claude/max-bot/docs/CLAUDE-NOTES.md`:

```markdown
## Milestone E — Accepted YYYY-MM-DD

- Live conversation with Max in TEST meeting via max-brain → max-bot stack
- bot_id: <uuid>
- (a) Max heard Suren: yes
- (b) Max's voice broadcast: yes
- (c) No echo: yes
- (d) Latency: ~Ns to first audio response
- (e) Persona intact: yes

Phase 1 of the self-hosting plan is COMPLETE. Ready for Milestone F (hardening).
```

Commit + push to max-bot's main branch.

---

## Milestone E acceptance checklist

- [ ] All Jest tests pass (42/42)
- [ ] max-bot Railway deploy `ACTIVE`, `/health` 200
- [ ] max-bot has `MAX_BRAIN_WS_URL` env var set
- [ ] max-brain code change merged to main on `suren-pm/max-brain`
- [ ] max-brain Railway service `ACTIVE` (un-paused)
- [ ] max-brain has `BOT_SERVICE_URL` env var set
- [ ] `POST /join` via max-brain returns 200 + bot_id and puts Max in the meeting
- [ ] **Suren has a coherent 30-60 second conversation with Max** — capture works, injection works, no echo
- [ ] CLAUDE-NOTES.md updated

When all 9 are checked: Phase 1 is COMPLETE. Self-hosted Max is functional end-to-end. The strategic value Suren wanted from the original April 28 pivot (break the MBaaS testing-cost ceiling, iterate on quality endlessly) is unlocked.

---

## What if E.9 fails partially

**If Max joins but says nothing back:**
- Most likely the WS bridge is connected but max-brain's Pipecat pipeline isn't producing TTS
- Check max-brain logs for STT activity (Deepgram should be transcribing what Suren says)
- Check max-brain logs for LLM activity (Claude Haiku 4.5 should produce a response)
- Check max-brain logs for TTS activity (Deepgram TTS should generate audio)
- If any of those are silent, the corresponding API key may be missing/wrong on max-brain Railway env

**If Max speaks but with echo of Suren's own voice:**
- D v2 acceptance involves NO echo. If it returns here, something disrupted the routing.
- Quick check: `curl /diag` on max-bot, verify `pulse_sources` shows TWO `.monitor` entries (virtual_speaker.monitor and virtual_mic_input.monitor)
- If only one, the second null-sink module didn't load — re-check Dockerfile

**If max-brain's /join returns 500:**
- Most likely `BOT_SERVICE_URL` env var typo (Task E.7 step 2)
- Or max-bot is returning 409 because a previous session is still active — /leave it first

**Do NOT propose pivots or workarounds per the hard rule in memory.** Diagnose root cause from logs and fix the actual problem.

---

## Self-review

**Spec coverage:**
- ✅ Section 4.2 of design spec: max-brain /join URL swap, strip MBaaS fields, add BOT_SERVICE_URL env → Tasks E.6 + E.7
- ✅ Section 9 of spec: max-brain stays in `sincere-grace` project, un-paused → Task E.7
- ✅ Cross-project networking via public Railway WSS URL → MAX_BRAIN_WS_URL env (Task E.5)
- ✅ Byte-identical protocol with MBaaS preserved → MaxBrainBridge connects to existing `/ws/{bot_id}` handler unchanged
- ✅ Spec's "30 lines of code change in max-brain" → Task E.6 net diff ~25 added, ~75 removed

**Placeholder scan:**
- `YYYY-MM-DD`, `<uuid>`, `~Ns` in Task E.9 step 5 are intentional fill-in-during-execution markers
- No "TBD", "similar to", or "implement later" patterns

**Type consistency:**
- `MaxBrainBridgeOptions` (E.1 test, E.2 impl) matches the constructor call in `/join` (E.3)
- `JoinSession.maxBrainBridge: MaxBrainBridge` is the same type added in E.3 step 1, used in E.3 step 3's `close()` callback
- `MAX_BRAIN_WS_URL` env var name consistent between E.3, E.5, and the architecture doc
- `BOT_SERVICE_URL` env var name consistent between E.6 code and E.7 dashboard setup

**Scope check:**
- Plan focuses on Milestone E only
- Touches both repos (max-bot, max-brain) — explicit and minimal in each
- Estimated time: 30-45 min for E.0-E.4 (TDD + deploy), 15 min for E.5 (env var + redeploy), 30-45 min for E.6 + E.7 (max-brain edit + un-pause), 15-30 min for E.8 + E.9 (live test). ~2 hours if everything goes right.

No issues found. Plan ready for execution.
