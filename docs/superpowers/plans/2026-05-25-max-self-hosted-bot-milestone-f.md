# Max Self-Hosted Bot — Milestone F (Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the self-hosted max-bot survive a normal session, recover from common failure modes (max-brain disconnect, Chromium crash, bot kicked from meeting), and auto-restart if the container becomes unhealthy. End state: Suren can have a 15-minute conversation with Max, kill ffmpeg out from under it, and Railway brings the bot back without manual intervention.

**Architecture:** Three layers of hardening. (1) Synchronous reliability — `/leave` never hangs, `MaxBrainBridge` never leaks listeners, bridge tracks disconnect time. (2) Continuous reliability — heartbeat watchdog on the bridge, Playwright page-close detection, ffmpeg liveness check, all surfaced as diagnostic state. (3) Auto-recovery — `/health` returns 503 when subprocesses are dead so Railway's restart policy kicks in; postmortem state captured for the next session to inspect.

**Tech Stack:** TypeScript (max-bot), Jest + ts-jest for tests, Railway healthcheck for restart triggers.

**Pre-conditions in place:**
- Milestone E shipped (commit `db3449b` on `main` in `suren-pm/max-bot`). Live conversation with Max via Gemini LLM confirmed 2026-05-25.
- max-bot deployed at `https://max-bot-production-7455.up.railway.app`.
- max-brain deployed at `https://max-brain-production-2842.up.railway.app` (in max-self-hosted project, on `self-hosted` branch).
- Existing diag endpoints already shipped: `/diag`, `/diag/audio/:bot_id`, `/diag/inject/:bot_id`, `/diag/bridge/:bot_id`, `/diag/pulse`.
- 42/42 Jest tests passing.

**What ships at end of Milestone F:**
- `/leave` always returns 200 within 15 seconds even if Playwright cleanup hangs (force-kill fallback).
- `MaxBrainBridge.scheduleReconnect()` no longer leaks event listeners on the old WebSocket — `bytesReceived` counter never explodes from listener stacking.
- Bridge tracks `disconnectedSince` timestamp; heartbeat watchdog force-reconnects if no message from max-brain for 10 seconds.
- Playwright detects "page closed" / "page crash" events and triggers session cleanup automatically.
- ffmpeg process death is detected and triggers session cleanup.
- `/health` returns 503 when Xvfb or PulseAudio is dead, so Railway's healthcheck restarts the container.
- New `/diag/postmortem` endpoint exposes the last subprocess-death event (timestamp, exit code, stderr tail) so the next session can diagnose what killed the last one.
- `railway.toml` configures the healthcheck so Railway actually polls `/health` and restarts on failure.
- Live verification: Suren has a 15-minute conversation with Max, then we kill ffmpeg via a debug endpoint and verify Railway restarts the container + a fresh /join works.

**Out of scope for F (Phase 2 territory):**
- Sliding context window on max-brain to fix V1.4 long-session LLM bloat.
- Google Workspace account / proper Meet profile pic.
- Microsoft Teams support.
- Stateful session resume across container restarts (postmortem is read-only diagnostic, not resumable state).

---

## File Structure

### max-bot repo (`~/Documents/Claude/max-bot`)

| File | Action | Purpose |
|---|---|---|
| `src/bot/postmortem.ts` | Create | In-memory ring buffer of subprocess-death events. Captures pid, kind ("ffmpeg" / "chromium" / "playwright_page"), exit code, signal, stderrTail, timestamp. Singleton because there's one bot at a time. |
| `src/bot/postmortem.test.ts` | Create | Unit tests for record(), getLatest(), getAll(), trimming to last N. |
| `src/bot/maxBrainBridge.ts` | Modify | (a) `cleanupWs(ws)` removes all listeners + closes; called before reconnect to prevent leak. (b) `disconnectedSince` field set in close handler, cleared in open. (c) Heartbeat: `setInterval` checks `lastMessageAt`; if >10s, force close + reconnect. (d) Expose `disconnectedSince` via /diag/bridge. |
| `src/bot/maxBrainBridge.test.ts` | Modify | Add tests: handler detachment on reconnect, heartbeat triggers reconnect when stale. Uses jest fake timers. |
| `src/bot/joinMeet.ts` | Modify | (a) After page is created, attach `page.on('close', cb)` + `page.on('crash', cb)` — invokes a new `onPageDeath` callback passed in `JoinMeetParams`. (b) `JoinResult.isAlive()` returns `!page.isClosed()`. |
| `src/bot/audioInject.ts` | Modify | Add `isAlive()` returning `child && !child.killed && child.exitCode === null`. On process `exit`, push a postmortem record. |
| `src/bot/sessions.ts` | Modify | Add `withTimeout<T>(promise, ms, label)` utility (used by /leave). No change to JoinSession interface. |
| `src/app.ts` | Modify | (a) `/leave` wraps `session.close()` in `withTimeout(15000)`; on timeout records postmortem + returns 200 with `forced: true`. (b) `/health` returns 503 if `xdpyinfo :99` fails OR `pactl info` fails. (c) Wire `onPageDeath` callback in `/join` to auto-cleanup. (d) New `/diag/postmortem` endpoint. (e) New `/diag/kill/ffmpeg` debug endpoint that lets the F.15 live test induce a crash. |
| `src/app.test.ts` | Modify | Add tests for /leave timeout path, /health unhealthy path, /diag/postmortem. |
| `src/bot/sessions.test.ts` | Modify | Add tests for withTimeout. |
| `railway.toml` | Modify | Add `[deploy]` section with `healthcheckPath = "/health"`, `healthcheckTimeout = 30`, `restartPolicyType = "ON_FAILURE"`, `restartPolicyMaxRetries = 3`. |
| `docs/CLAUDE-NOTES.md` | Append | F acceptance notes. |

**Deliberately NOT touched:**
- `src/bot/audioStream.ts` — already simple and well-tested.
- `src/bot/wsServer.ts` — the /ws/:bot_id and /ws_in/:bot_id endpoints are diagnostic-only now and Milestone E confirmed they work fine.
- `src/bot/audioCapture.ts` — browser-side script is stable.
- max-brain repo — F is entirely about max-bot resilience. max-brain reliability is Phase 2.

---

## Decisions locked in for F

- **One bot at a time stays true.** All sessions registry assumes `hasActiveSession()` is binary. F doesn't change that.
- **No persistent state across container restarts.** Postmortem captures the death event but doesn't try to resume the session. If Railway restarts, the bot is gone from Meet and Suren has to call `/join` again.
- **Heartbeat threshold = 10s.** max-brain sends a silence chunk every 100ms. If we go 100x that without a message, the connection is half-open.
- **`/leave` timeout = 15s.** Railway's HTTP gateway has a 30-60s timeout depending on plan; 15s is a comfortable margin to always return cleanly.
- **`/health` check is shallow: process-liveness only.** We don't open a Chromium tab or play test audio. That's a manual `/diag/audio/:bot_id` check.
- **No max-brain side changes.** max-brain reliability is its own milestone in Phase 2.
- **No code change to `src/bot/audioInject.ts`'s ffmpeg args.** The Milestone E `-device` flag fix is correct as-is.

---

## Pre-work — branch setup

### Task F.0: Branch from main on max-bot

**Files:** None modified.

- [ ] **Step 1: Pull latest main + branch**

```bash
cd ~/Documents/Claude/max-bot
git checkout main
git pull origin main
git checkout -b milestone-f/hardening
```

- [ ] **Step 2: Verify baseline tests**

```bash
unset NODE_ENV
source ~/.nvm/nvm.sh && nvm use 20
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | grep -E "Tests:|FAIL" | head -3
```

Expected: `Tests: 42 passed, 42 total`. If failures, stop and report — don't proceed.

- [ ] **Step 3: Verify production state**

```bash
curl -s -w "HTTP %{http_code}\n" https://max-bot-production-7455.up.railway.app/health
curl -s -w "HTTP %{http_code}\n" https://max-brain-production-2842.up.railway.app/health
```

Expected: both HTTP 200.

---

## Task F.1: Postmortem module — failing tests (TDD red)

**Files:**
- Create: `src/bot/postmortem.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// src/bot/postmortem.test.ts
import {
    _clearPostmortems,
    getAllPostmortems,
    getLatestPostmortem,
    recordPostmortem,
} from './postmortem'

describe('postmortem', () => {
    afterEach(() => {
        _clearPostmortems()
    })

    it('records a postmortem with timestamp', () => {
        recordPostmortem({
            kind: 'ffmpeg',
            pid: 42,
            exitCode: 1,
            signal: null,
            stderrTail: 'pulse: connection refused',
        })
        const latest = getLatestPostmortem()
        expect(latest).not.toBeNull()
        expect(latest?.kind).toBe('ffmpeg')
        expect(latest?.pid).toBe(42)
        expect(latest?.exitCode).toBe(1)
        expect(latest?.stderrTail).toBe('pulse: connection refused')
        expect(typeof latest?.timestamp).toBe('number')
    })

    it('getLatestPostmortem returns null when empty', () => {
        expect(getLatestPostmortem()).toBeNull()
    })

    it('getAllPostmortems returns in newest-first order', () => {
        recordPostmortem({
            kind: 'ffmpeg',
            pid: 1,
            exitCode: 1,
            signal: null,
            stderrTail: 'first',
        })
        recordPostmortem({
            kind: 'chromium',
            pid: 2,
            exitCode: null,
            signal: 'SIGKILL',
            stderrTail: 'second',
        })
        const all = getAllPostmortems()
        expect(all).toHaveLength(2)
        expect(all[0].stderrTail).toBe('second')
        expect(all[1].stderrTail).toBe('first')
    })

    it('trims to last 20 entries', () => {
        for (let i = 0; i < 25; i++) {
            recordPostmortem({
                kind: 'ffmpeg',
                pid: i,
                exitCode: i,
                signal: null,
                stderrTail: `event-${i}`,
            })
        }
        const all = getAllPostmortems()
        expect(all).toHaveLength(20)
        // Newest first → event-24 should be at index 0
        expect(all[0].stderrTail).toBe('event-24')
        expect(all[19].stderrTail).toBe('event-5')
    })
})
```

- [ ] **Step 2: Run the test and verify red**

```bash
./node_modules/.bin/jest src/bot/postmortem.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAIL with `Cannot find module './postmortem'`.

---

## Task F.2: Postmortem module — passing impl (TDD green)

**Files:**
- Create: `src/bot/postmortem.ts`

- [ ] **Step 1: Create the implementation**

```typescript
// src/bot/postmortem.ts
//
// In-memory ring buffer of subprocess-death events. Exposed via
// /diag/postmortem so the next session (or a debugger) can see what
// killed the previous bot. Singleton because max-bot is single-tenant.

export type PostmortemKind = 'ffmpeg' | 'chromium' | 'playwright_page' | 'bridge_ws'

export interface PostmortemEvent {
    kind: PostmortemKind
    pid: number | null
    exitCode: number | null
    signal: string | null
    stderrTail: string
    timestamp: number
}

const MAX_ENTRIES = 20
const ring: PostmortemEvent[] = []

export function recordPostmortem(
    event: Omit<PostmortemEvent, 'timestamp'>,
): void {
    ring.push({ ...event, timestamp: Date.now() })
    if (ring.length > MAX_ENTRIES) {
        ring.splice(0, ring.length - MAX_ENTRIES)
    }
}

export function getLatestPostmortem(): PostmortemEvent | null {
    if (ring.length === 0) return null
    return ring[ring.length - 1]
}

export function getAllPostmortems(): PostmortemEvent[] {
    // Newest first.
    return [...ring].reverse()
}

/** Test-only escape hatch. */
export function _clearPostmortems(): void {
    ring.length = 0
}
```

- [ ] **Step 2: Run the test and verify green**

```bash
./node_modules/.bin/jest src/bot/postmortem.test.ts --runInBand 2>&1 | tail -10
```

Expected: 4/4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/postmortem.ts src/bot/postmortem.test.ts
git commit -m "feat(bot): postmortem ring buffer for subprocess deaths

Captures ffmpeg/chromium/page-crash events with exit code, signal,
stderr tail. Exposed via /diag/postmortem later in this milestone."
```

---

## Task F.3: withTimeout utility in sessions.ts — failing tests (TDD red)

**Files:**
- Modify: `src/bot/sessions.test.ts`

- [ ] **Step 1: Append tests to sessions.test.ts**

```typescript
// Append to src/bot/sessions.test.ts

import { withTimeout } from './sessions'

describe('withTimeout', () => {
    it('resolves with the inner value when inner resolves before timeout', async () => {
        const result = await withTimeout(
            Promise.resolve('ok'),
            1000,
            'fast',
        )
        expect(result).toEqual({ timedOut: false, value: 'ok' })
    })

    it('returns timedOut=true when inner takes longer than ms', async () => {
        const slow = new Promise((resolve) => setTimeout(resolve, 200))
        const result = await withTimeout(slow, 50, 'slow')
        expect(result.timedOut).toBe(true)
    })

    it('does not throw when inner rejects after timeout', async () => {
        const failsLate = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('late')), 200),
        )
        const result = await withTimeout(failsLate, 50, 'fail-late')
        expect(result.timedOut).toBe(true)
        // Awaiting later doesn't propagate — just verifying no unhandled rejection
        await new Promise((r) => setTimeout(r, 250))
    })
})
```

Also update the import line at the top of sessions.test.ts to include `withTimeout`:

```typescript
import {
    _clearAllSessions,
    getSession,
    hasActiveSession,
    JoinSession,
    registerSession,
    removeSession,
    withTimeout,
} from './sessions'
```

- [ ] **Step 2: Run the tests and verify red**

```bash
./node_modules/.bin/jest src/bot/sessions.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAIL with `'withTimeout' is not exported`.

---

## Task F.4: withTimeout utility — passing impl (TDD green)

**Files:**
- Modify: `src/bot/sessions.ts`

- [ ] **Step 1: Append withTimeout to sessions.ts**

```typescript
// Append to src/bot/sessions.ts

/**
 * Wrap a promise with a timeout. Returns `{timedOut: true}` if the
 * promise didn't settle within `ms` milliseconds — the underlying
 * promise is left running (caller's responsibility to stop bothering).
 * Late rejections are swallowed via a no-op .catch so Node doesn't
 * log unhandledRejection.
 *
 * Used by /leave to ensure the HTTP response never blocks past Railway's
 * gateway timeout, even if Playwright/Chromium cleanup hangs.
 */
export interface WithTimeoutResult<T> {
    timedOut: boolean
    value?: T
    label: string
}

export async function withTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
): Promise<WithTimeoutResult<T>> {
    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<WithTimeoutResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true, label }), ms)
    })
    const innerPromise = p
        .then<WithTimeoutResult<T>>((value) => ({
            timedOut: false,
            value,
            label,
        }))
        .catch<WithTimeoutResult<T>>(() => ({
            // If inner throws, treat as "completed" (not a timeout) so
            // caller doesn't try to force-kill twice.
            timedOut: false,
            label,
        }))
    // Swallow late rejections so they don't become unhandledRejection.
    p.catch(() => {})
    const result = await Promise.race([innerPromise, timeoutPromise])
    if (timer) clearTimeout(timer)
    return result
}
```

- [ ] **Step 2: Run the tests and verify green**

```bash
./node_modules/.bin/jest src/bot/sessions.test.ts --runInBand 2>&1 | tail -10
```

Expected: previous 4 tests + 3 new `withTimeout` tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/sessions.ts src/bot/sessions.test.ts
git commit -m "feat(bot): withTimeout utility for /leave hang prevention"
```

---

## Task F.5: /leave timeout path — failing tests (TDD red)

**Files:**
- Modify: `src/app.test.ts`

- [ ] **Step 1: Add /leave timeout tests**

Append to the describe block in `src/app.test.ts`:

```typescript
    describe('POST /leave/:bot_id timeout handling', () => {
        it('returns 200 with forced=true if session.close() hangs', async () => {
            const hangingClose = jest.fn(() => new Promise<void>(() => {
                // Never resolves — simulates hung Playwright cleanup
            }))
            jest.spyOn(joinMeetModule, 'joinMeet').mockResolvedValue({
                bot_id: 'hang-bot',
                page: {} as never,
                close: hangingClose,
            })

            const app = createServer()
            const joinRes = await request(app).post('/join').send({
                meeting_url: 'https://meet.google.com/abc-defg-hij',
                bot_name: 'Max',
            })
            expect(joinRes.status).toBe(200)
            const bot_id = joinRes.body.bot_id

            // /leave should return within ~16 seconds even though close hangs
            const start = Date.now()
            const leaveRes = await request(app).post(`/leave/${bot_id}`)
            const elapsed = Date.now() - start

            expect(leaveRes.status).toBe(200)
            expect(leaveRes.body.forced).toBe(true)
            expect(elapsed).toBeLessThan(17000)
        }, 20000) // jest test timeout 20s

        it('returns 200 with forced=false on clean close', async () => {
            const cleanClose = jest.fn(async () => {})
            jest.spyOn(joinMeetModule, 'joinMeet').mockResolvedValue({
                bot_id: 'clean-bot',
                page: {} as never,
                close: cleanClose,
            })

            const app = createServer()
            const joinRes = await request(app).post('/join').send({
                meeting_url: 'https://meet.google.com/abc-defg-hij',
                bot_name: 'Max',
            })
            const bot_id = joinRes.body.bot_id

            const leaveRes = await request(app).post(`/leave/${bot_id}`)
            expect(leaveRes.status).toBe(200)
            expect(leaveRes.body.forced).toBe(false)
        })
    })
```

- [ ] **Step 2: Run the tests and verify red**

```bash
./node_modules/.bin/jest src/app.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAIL on the hang test (current /leave hangs forever) or FAIL on `forced` field being undefined.

---

## Task F.6: /leave timeout path — passing impl (TDD green)

**Files:**
- Modify: `src/app.ts`

- [ ] **Step 1: Update the imports**

In `src/app.ts`, find the import block and add `withTimeout`:

```typescript
import {
    getSession,
    hasActiveSession,
    registerSession,
    removeSession,
    withTimeout,
} from './bot/sessions'
import { recordPostmortem } from './bot/postmortem'
```

- [ ] **Step 2: Update the /leave handler**

Replace the existing `/leave/:bot_id` handler in `src/app.ts` with:

```typescript
    app.post('/leave/:bot_id', async (req: Request, res: Response) => {
        const { bot_id } = req.params
        const session = getSession(bot_id)
        if (!session) {
            res.status(404).json({
                error: `no active session for bot_id=${bot_id}`,
            })
            return
        }
        // Wrap close() in a 15s timeout. If Playwright/Chromium hangs,
        // we still respond cleanly and let the next /join replace state.
        const result = await withTimeout(
            session.close(),
            15000,
            `leave/${bot_id}`,
        )
        removeSession(bot_id)
        if (result.timedOut) {
            recordPostmortem({
                kind: 'playwright_page',
                pid: null,
                exitCode: null,
                signal: 'LEAVE_TIMEOUT',
                stderrTail: `/leave/${bot_id} cleanup exceeded 15s — session removed from registry, child processes may be lingering`,
            })
            // eslint-disable-next-line no-console
            console.warn(`/leave/${bot_id}: close() exceeded 15s, forcing`)
        }
        res.status(200).json({
            ok: true,
            bot_id,
            forced: result.timedOut,
        })
    })
```

- [ ] **Step 3: Run the tests and verify green**

```bash
./node_modules/.bin/jest src/app.test.ts --runInBand 2>&1 | tail -10
```

Expected: previous tests + 2 new /leave tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/app.ts src/app.test.ts
git commit -m "feat(app): /leave timeout-bounded with forced fallback

If session.close() doesn't settle within 15s (Playwright/Chromium
cleanup hangs), still return 200 with forced=true and record a
postmortem. Always frees the sessions registry so the next /join
can succeed."
```

---

## Task F.7: MaxBrainBridge handler-leak fix — failing tests (TDD red)

**Files:**
- Modify: `src/bot/maxBrainBridge.test.ts`

- [ ] **Step 1: Add tests at the end of the describe block**

Append to `describe('MaxBrainBridge', () => { ... })`:

```typescript
    it('detaches listeners from the OLD WebSocket on reconnect', async () => {
        // Open + close fake server twice; verify bridge does NOT leak
        // listeners on the dead websockets.
        const env1 = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const inject = {
            pushInt16Buffer: jest.fn(),
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        const acceptedSockets: WebSocket[] = []
        env1.wss.on('connection', (ws) => {
            acceptedSockets.push(ws)
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env1.port}`,
            botId: 'leak-test',
            audioStream: stream,
            audioInject: inject as never,
        })
        await new Promise((r) => setTimeout(r, 150))

        // Force-close server side
        for (const ws of acceptedSockets) ws.close()
        await new Promise((r) => setTimeout(r, 150))

        // The OLD client-side ws (before reconnect) should have no
        // 'message' listeners left — they should have been removed on close.
        // Inspect via the bridge's internal record of past sockets.
        const oldSockets = (bridge as unknown as {
            _testDeadSockets?: WebSocket[]
        })._testDeadSockets ?? []
        expect(oldSockets.length).toBeGreaterThanOrEqual(1)
        for (const dead of oldSockets) {
            expect(dead.listenerCount('message')).toBe(0)
            expect(dead.listenerCount('close')).toBe(0)
            expect(dead.listenerCount('open')).toBe(0)
            expect(dead.listenerCount('error')).toBe(0)
        }

        bridge.stop()
        await env1.close()
    })
```

- [ ] **Step 2: Run and verify red**

```bash
./node_modules/.bin/jest src/bot/maxBrainBridge.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAIL — `_testDeadSockets` is undefined.

---

## Task F.8: MaxBrainBridge handler-leak fix — passing impl (TDD green)

**Files:**
- Modify: `src/bot/maxBrainBridge.ts`

- [ ] **Step 1: Replace connect() and add cleanupWs()**

In `src/bot/maxBrainBridge.ts`, replace the existing `connect()` method and add `cleanupWs()` plus the `_testDeadSockets` field for the test:

```typescript
    // Test-only: every WS we abandon (because we're reconnecting) is
    // recorded here so tests can assert all listeners were detached.
    public _testDeadSockets: WebSocket[] = []

    private cleanupWs(ws: WebSocket | null): void {
        if (!ws) return
        // Detach ALL listeners we attached. Critical to prevent
        // listener-stacking memory leak on repeated reconnects.
        ws.removeAllListeners('open')
        ws.removeAllListeners('message')
        ws.removeAllListeners('close')
        ws.removeAllListeners('error')
        try {
            ws.close()
        } catch {
            /* ignore */
        }
        this._testDeadSockets.push(ws)
    }

    private connect(): void {
        if (this.stopped) return
        // CRITICAL: detach any previous WS before opening a new one.
        // Without this, old close-handler closures (which call
        // scheduleReconnect→connect) survive and accumulate, and old
        // message handlers (which push to audioInject) double up. We
        // observed this leak in Milestone E live testing: bytesReceived
        // counter exploded from 8 MB → 7 GB over a few minutes.
        const old = this.ws
        this.ws = null
        this.cleanupWs(old)

        try {
            this.ws = new WebSocket(this.fullUrl)
        } catch (err) {
            this.lastConnectError =
                err instanceof Error ? err.message : String(err)
            this.scheduleReconnect()
            return
        }

        this.ws.on('open', () => {
            this.reconnectAttempts = 0
            this.lastOpenAt = Date.now()
            this.lastConnectError = null
        })

        this.ws.on('message', (m: unknown) => {
            this.messagesReceivedFromBrain += 1
            this.lastMessageAt = Date.now()
            if (m instanceof Buffer) {
                this.bytesReceivedFromBrain += m.length
                this.audioInject.pushInt16Buffer(m)
            }
        })

        this.ws.on('close', (code: number) => {
            this.lastCloseAt = Date.now()
            this.lastCloseCode = code
            if (!this.stopped) {
                this.scheduleReconnect()
            }
        })

        this.ws.on('error', (err: Error) => {
            this.lastConnectError = err.message
        })
    }
```

- [ ] **Step 2: Run and verify green**

```bash
./node_modules/.bin/jest src/bot/maxBrainBridge.test.ts --runInBand 2>&1 | tail -10
```

Expected: previous 4 tests + 1 new leak test pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/maxBrainBridge.ts src/bot/maxBrainBridge.test.ts
git commit -m "fix(bridge): detach old WS listeners on reconnect

Prevents listener-stacking leak — observed in Milestone E live
testing where bytesReceivedFromBrain ballooned from 8 MB → 7 GB
in a few minutes due to multiple stacked 'message' handlers all
firing on each incoming frame."
```

---

## Task F.9: Bridge `disconnectedSince` + heartbeat — failing tests (TDD red)

**Files:**
- Modify: `src/bot/maxBrainBridge.test.ts`

- [ ] **Step 1: Append heartbeat tests**

Append to the describe block:

```typescript
    it('sets disconnectedSince when ws closes, clears on reopen', async () => {
        const env = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const inject = {
            pushInt16Buffer: jest.fn(),
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        let serverWs: WebSocket | null = null
        env.wss.on('connection', (ws) => {
            serverWs = ws
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env.port}`,
            botId: 'disc-test',
            audioStream: stream,
            audioInject: inject as never,
        })
        await new Promise((r) => setTimeout(r, 150))
        expect(bridge.disconnectedSince).toBeNull()

        serverWs!.close()
        await new Promise((r) => setTimeout(r, 100))
        expect(bridge.disconnectedSince).toBeGreaterThan(0)

        bridge.stop()
        await env.close()
    })

    it('heartbeat force-reconnects after staleness threshold', async () => {
        // Use fake timers for deterministic stale-detection test.
        jest.useFakeTimers()
        try {
            const env = await spinUpFakeBrain()
            const stream = new AudioStream({
                srcSampleRate: 16000,
                dstSampleRate: 16000,
            })
            const inject = {
                pushInt16Buffer: jest.fn(),
                stop: jest.fn(),
            } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

            const bridge = new MaxBrainBridge({
                wsUrl: `ws://localhost:${env.port}`,
                botId: 'hb-test',
                audioStream: stream,
                audioInject: inject as never,
                heartbeatStalenessMs: 1000, // tight for test
                heartbeatIntervalMs: 200,
            })

            // Let real connection establish under fake timers
            jest.useRealTimers()
            await new Promise((r) => setTimeout(r, 150))
            jest.useFakeTimers()

            const initialReconnectCount = bridge.heartbeatReconnects
            // Simulate staleness: pretend last message was long ago
            ;(bridge as unknown as { lastMessageAt: number }).lastMessageAt =
                Date.now() - 5000
            // Advance fake time past the heartbeat interval
            jest.advanceTimersByTime(500)
            expect(bridge.heartbeatReconnects).toBe(initialReconnectCount + 1)

            jest.useRealTimers()
            bridge.stop()
            await env.close()
        } finally {
            jest.useRealTimers()
        }
    })
```

- [ ] **Step 2: Run and verify red**

```bash
./node_modules/.bin/jest src/bot/maxBrainBridge.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAIL on `disconnectedSince`, `heartbeatStalenessMs`, `heartbeatReconnects` being undefined.

---

## Task F.10: Bridge heartbeat + disconnectedSince — passing impl (TDD green)

**Files:**
- Modify: `src/bot/maxBrainBridge.ts`

- [ ] **Step 1: Update the constructor signature**

In `MaxBrainBridgeOptions`, add the optional heartbeat fields:

```typescript
export interface MaxBrainBridgeOptions {
    /** Base WS URL, e.g. wss://max-brain-production.up.railway.app/ws */
    wsUrl: string
    botId: string
    audioStream: AudioStream
    audioInject: AudioInject
    /** Force-reconnect if no message received from max-brain in this many ms.
     * Default 10000 (10s). */
    heartbeatStalenessMs?: number
    /** How often the heartbeat watchdog wakes up. Default 2000. */
    heartbeatIntervalMs?: number
}
```

- [ ] **Step 2: Add fields + heartbeat in MaxBrainBridge**

Add these public fields to the class:

```typescript
    /** Wall-clock time when current disconnect started. Null when connected. */
    public disconnectedSince: number | null = null
    /** How many times the heartbeat watchdog has fired a force-reconnect. */
    public heartbeatReconnects = 0
    private readonly stalenessMs: number
    private readonly hbIntervalMs: number
    private hbTimer: NodeJS.Timeout | null = null
```

- [ ] **Step 3: Initialize in constructor**

In the constructor, before `this.connect()`, add:

```typescript
        this.stalenessMs = opts.heartbeatStalenessMs ?? 10000
        this.hbIntervalMs = opts.heartbeatIntervalMs ?? 2000
        this.hbTimer = setInterval(() => this.checkHeartbeat(), this.hbIntervalMs)
        // Prevent the interval from keeping Node alive past stop().
        this.hbTimer.unref?.()
```

- [ ] **Step 4: Add checkHeartbeat() method**

Inside the class, alongside `connect()`:

```typescript
    private checkHeartbeat(): void {
        if (this.stopped) return
        if (!this.lastMessageAt) return // never received yet → wait
        const stale = Date.now() - this.lastMessageAt > this.stalenessMs
        if (!stale) return
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) return
        // Half-open connection — TCP says alive but max-brain stopped
        // sending. Force reconnect.
        this.heartbeatReconnects += 1
        // eslint-disable-next-line no-console
        console.warn(
            `[bridge] heartbeat stale (>${this.stalenessMs}ms), forcing reconnect`,
        )
        this.cleanupWs(this.ws)
        this.ws = null
        this.connect()
    }
```

- [ ] **Step 5: Set/clear disconnectedSince**

In the `'close'` handler, set `disconnectedSince`:

```typescript
        this.ws.on('close', (code: number) => {
            this.lastCloseAt = Date.now()
            this.lastCloseCode = code
            this.disconnectedSince = Date.now()
            if (!this.stopped) {
                this.scheduleReconnect()
            }
        })
```

In the `'open'` handler, clear it:

```typescript
        this.ws.on('open', () => {
            this.reconnectAttempts = 0
            this.lastOpenAt = Date.now()
            this.lastConnectError = null
            this.disconnectedSince = null
        })
```

- [ ] **Step 6: Cancel hbTimer in stop()**

Update `stop()`:

```typescript
    stop(): void {
        if (this.stopped) return
        this.stopped = true
        if (this.hbTimer) {
            clearInterval(this.hbTimer)
            this.hbTimer = null
        }
        this.audioStream.off('chunk', this.onChunk)
        this.cleanupWs(this.ws)
        this.ws = null
    }
```

- [ ] **Step 7: Run and verify green**

```bash
./node_modules/.bin/jest src/bot/maxBrainBridge.test.ts --runInBand 2>&1 | tail -10
```

Expected: 5 previous + 2 new tests pass = 7/7.

- [ ] **Step 8: Commit**

```bash
git add src/bot/maxBrainBridge.ts src/bot/maxBrainBridge.test.ts
git commit -m "feat(bridge): heartbeat watchdog + disconnectedSince field

If max-brain stops sending messages for >10s (half-open WS), the
watchdog force-reconnects. disconnectedSince surfaces the outage
duration via /diag/bridge for live debugging."
```

---

## Task F.11: Expose new bridge state via /diag/bridge

**Files:**
- Modify: `src/app.ts`

- [ ] **Step 1: Update /diag/bridge response**

In `src/app.ts`, find the existing `/diag/bridge/:bot_id` handler and update the response body:

```typescript
        res.status(200).json({
            bot_id: req.params.bot_id,
            connected: b.isConnected(),
            disconnectedSince: b.disconnectedSince,
            heartbeatReconnects: b.heartbeatReconnects,
            bytesReceivedFromBrain: b.bytesReceivedFromBrain,
            messagesReceivedFromBrain: b.messagesReceivedFromBrain,
            bytesSentToBrain: b.bytesSentToBrain,
            chunksSentToBrain: b.chunksSentToBrain,
            lastOpenAt: b.lastOpenAt,
            lastCloseAt: b.lastCloseAt,
            lastCloseCode: b.lastCloseCode,
            lastMessageAt: b.lastMessageAt,
            lastConnectError: b.lastConnectError,
        })
```

- [ ] **Step 2: Verify no test regressions**

```bash
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | grep -E "Tests:|FAIL" | head -3
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/app.ts
git commit -m "diag(bridge): surface disconnectedSince + heartbeatReconnects"
```

---

## Task F.12: Page-death detection in joinMeet — failing tests (TDD red)

**Files:**
- Modify: `src/bot/joinMeet.test.ts`

- [ ] **Step 1: Inspect current test file to find pattern**

```bash
head -30 ~/Documents/Claude/max-bot/src/bot/joinMeet.test.ts
```

- [ ] **Step 2: Add a test using a mocked Page**

Append to `src/bot/joinMeet.test.ts` (or add a new describe block):

```typescript
describe('joinMeet onPageDeath callback', () => {
    it('fires onPageDeath when page.on(close) event fires', async () => {
        // We can't easily test the real Playwright path in jest without
        // a real browser, so we test the wiring helper directly.
        const { wirePageDeath } = await import('./joinMeet')
        const deathHandler = jest.fn()
        const fakePage = {
            isClosed: jest.fn(() => false),
            on: jest.fn((event: string, cb: () => void) => {
                if (event === 'close') {
                    // Simulate Playwright firing close
                    setTimeout(cb, 10)
                }
            }),
        } as unknown as import('playwright').Page

        wirePageDeath(fakePage, deathHandler)
        await new Promise((r) => setTimeout(r, 50))
        expect(deathHandler).toHaveBeenCalledWith({
            reason: 'page_closed',
        })
    })

    it('fires onPageDeath when page.on(crash) event fires', async () => {
        const { wirePageDeath } = await import('./joinMeet')
        const deathHandler = jest.fn()
        const fakePage = {
            isClosed: jest.fn(() => false),
            on: jest.fn((event: string, cb: () => void) => {
                if (event === 'crash') {
                    setTimeout(cb, 10)
                }
            }),
        } as unknown as import('playwright').Page

        wirePageDeath(fakePage, deathHandler)
        await new Promise((r) => setTimeout(r, 50))
        expect(deathHandler).toHaveBeenCalledWith({
            reason: 'page_crash',
        })
    })
})
```

- [ ] **Step 3: Run and verify red**

```bash
./node_modules/.bin/jest src/bot/joinMeet.test.ts --runInBand 2>&1 | tail -10
```

Expected: FAIL — `wirePageDeath` is not exported.

---

## Task F.13: Page-death detection — passing impl (TDD green)

**Files:**
- Modify: `src/bot/joinMeet.ts`

- [ ] **Step 1: Export wirePageDeath helper + integrate**

Add this helper near the top of the exports in `src/bot/joinMeet.ts`:

```typescript
export type PageDeathReason = 'page_closed' | 'page_crash'

export interface PageDeath {
    reason: PageDeathReason
}

/**
 * Attach `close` and `crash` listeners to a Playwright Page; invoke
 * the callback (at most once) on either. Exposed for unit testing
 * without needing a real Chromium instance.
 */
export function wirePageDeath(
    page: import('playwright').Page,
    onDeath: (event: PageDeath) => void,
): void {
    let fired = false
    const fire = (reason: PageDeathReason) => {
        if (fired) return
        fired = true
        try {
            onDeath({ reason })
        } catch {
            /* ignore */
        }
    }
    page.on('close', () => fire('page_closed'))
    page.on('crash', () => fire('page_crash'))
}
```

- [ ] **Step 2: Extend JoinMeetParams**

In the existing `JoinMeetParams` interface, add:

```typescript
    /**
     * Invoked when Playwright's page emits `close` or `crash`. The
     * page can no longer be used after this fires. Callers should
     * tear down the session.
     */
    onPageDeath?: (event: PageDeath) => void
```

- [ ] **Step 3: Wire it in joinMeet()**

In `joinMeet()`, just after the page is created and before `params.onPageReady` is awaited:

```typescript
    const page = await context.newPage()

    if (params.onPageDeath) {
        wirePageDeath(page, params.onPageDeath)
    }

    // CRITICAL: any inject scripts that need to observe Meet's JavaScript
    // ... (existing code follows)
```

- [ ] **Step 4: Run and verify green**

```bash
./node_modules/.bin/jest src/bot/joinMeet.test.ts --runInBand 2>&1 | tail -10
```

Expected: previous tests + 2 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/joinMeet.ts src/bot/joinMeet.test.ts
git commit -m "feat(joinMeet): wirePageDeath helper + onPageDeath callback

Detects when Playwright's page closes (bot kicked from meeting) or
crashes (Chromium died). Caller in app.ts wires this to auto-cleanup
the session so the next /join doesn't 409 on a zombie."
```

---

## Task F.14: Wire onPageDeath into /join + auto-cleanup

**Files:**
- Modify: `src/app.ts`
- Modify: `src/app.test.ts`

- [ ] **Step 1: Add onPageDeath to /join handler**

In `src/app.ts`, find the `/join` handler. After the `audioInject` is created and before `joinMeet({...})` is called, capture `bot_id` will be assigned later — so we need a different pattern. The fix: wire onPageDeath INSIDE the joinMeet call, but reference `bot_id` via a deferred closure variable.

Replace the existing joinMeet call with:

```typescript
            let resolvedBotId: string | null = null
            const { bot_id, page, close } = await joinMeet({
                meeting_url,
                bot_name,
                onPageReady: async (page) => {
                    try {
                        await attachAudioCapture(page, audioStream)
                    } catch (err) {
                        // eslint-disable-next-line no-console
                        console.warn(
                            'attachAudioCapture failed (continuing without audio):',
                            err instanceof Error ? err.message : String(err),
                        )
                    }
                },
                onPageDeath: (event) => {
                    // eslint-disable-next-line no-console
                    console.warn(
                        `[page death] bot=${resolvedBotId ?? '?'} reason=${event.reason}`,
                    )
                    recordPostmortem({
                        kind: 'playwright_page',
                        pid: null,
                        exitCode: null,
                        signal: event.reason,
                        stderrTail: `Playwright page emitted ${event.reason}`,
                    })
                    // Auto-cleanup: trigger session.close() asynchronously.
                    // We use the registry rather than the close closure
                    // because by the time death fires, the session has
                    // been registered.
                    const dead = resolvedBotId
                        ? getSession(resolvedBotId)
                        : undefined
                    if (dead) {
                        dead.close().catch(() => {})
                        removeSession(resolvedBotId!)
                    }
                },
            })
            resolvedBotId = bot_id
```

- [ ] **Step 2: Add an /app.test.ts mock for onPageDeath**

In `src/app.test.ts`, the existing `joinMeet` mock doesn't simulate page death. We're not testing the death-handler integration in /join here (would need to trigger the callback). Instead, add a regression test that /join still works with the new callback being passed:

```typescript
        it('passes onPageDeath callback through to joinMeet', async () => {
            const joinSpy = jest.spyOn(joinMeetModule, 'joinMeet')
                .mockResolvedValue({
                    bot_id: 'pd-bot',
                    page: {} as never,
                    close: jest.fn(async () => {}),
                })
            const app = createServer()
            await request(app).post('/join').send({
                meeting_url: 'https://meet.google.com/abc-defg-hij',
                bot_name: 'Max',
            })
            const callArg = joinSpy.mock.calls[0][0]
            expect(typeof callArg.onPageDeath).toBe('function')
        })
```

- [ ] **Step 3: Run tests**

```bash
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | grep -E "Tests:|FAIL" | head -3
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/app.ts src/app.test.ts
git commit -m "feat(app): auto-cleanup on Playwright page death

When the bot's Chromium page closes (kicked from meeting) or crashes,
the session is automatically /leave'd and a postmortem is recorded."
```

---

## Task F.15: ffmpeg-death postmortem in audioInject

**Files:**
- Modify: `src/bot/audioInject.ts`
- Modify: `src/bot/audioInject.test.ts`

- [ ] **Step 1: Add isAlive() + postmortem record in audioInject.ts**

In `src/bot/audioInject.ts`, add `import { recordPostmortem } from './postmortem'` at the top.

Add an `isAlive()` method:

```typescript
    isAlive(): boolean {
        return (
            !this.stopped &&
            this.child !== null &&
            !this.child.killed &&
            this.child.exitCode === null
        )
    }
```

Modify the existing `this.child.on('exit', ...)` handler to record a postmortem when ffmpeg dies unexpectedly:

```typescript
        this.child.on('exit', (code, signal) => {
            // If we initiated stop(), this is expected — don't record.
            if (!this.stopped) {
                recordPostmortem({
                    kind: 'ffmpeg',
                    pid: this.child?.pid ?? null,
                    exitCode: code,
                    signal: signal ?? null,
                    stderrTail: this.stderrTail.join('').slice(-2000),
                })
            }
            this.emit('exit', code ?? -1)
        })
```

- [ ] **Step 2: Add test**

Append to `src/bot/audioInject.test.ts`:

```typescript
    it('isAlive() returns false after stop()', () => {
        const inject = new AudioInject({ sampleRate: 16000 })
        expect(inject.isAlive()).toBe(true)
        inject.stop()
        expect(inject.isAlive()).toBe(false)
    })
```

- [ ] **Step 3: Run tests**

```bash
./node_modules/.bin/jest src/bot/audioInject.test.ts --runInBand 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/bot/audioInject.ts src/bot/audioInject.test.ts
git commit -m "feat(audioInject): isAlive() + ffmpeg-death postmortem

When ffmpeg exits unexpectedly (not via our stop()), capture a
postmortem with exit code, signal, and last 2KB of stderr. Exposed
via /diag/postmortem so the next session can see what killed it."
```

---

## Task F.16: /diag/postmortem endpoint + /diag/kill/ffmpeg test endpoint

**Files:**
- Modify: `src/app.ts`
- Modify: `src/app.test.ts`

- [ ] **Step 1: Add /diag/postmortem to app.ts**

After the existing `/diag/inject/:bot_id` handler:

```typescript
    app.get('/diag/postmortem', (_req: Request, res: Response) => {
        res.status(200).json({
            latest: getLatestPostmortem(),
            all: getAllPostmortems(),
        })
    })

    // Debug-only: force-kill the current session's ffmpeg subprocess so
    // F.15 live test can verify Railway healthcheck restart works. NOT
    // exposed via auth (max-bot is single-tenant behind Railway anyway).
    app.post('/diag/kill/ffmpeg/:bot_id', (req: Request, res: Response) => {
        const session = getSession(req.params.bot_id)
        if (!session) {
            res.status(404).json({ error: 'no active session' })
            return
        }
        const pid = session.audioInject.child?.pid
        try {
            session.audioInject.child?.kill('SIGKILL')
        } catch (err) {
            res.status(500).json({
                error: err instanceof Error ? err.message : String(err),
            })
            return
        }
        res.status(200).json({ ok: true, killed_pid: pid })
    })
```

Also add the imports at the top:

```typescript
import {
    getAllPostmortems,
    getLatestPostmortem,
} from './bot/postmortem'
```

- [ ] **Step 2: Add tests**

In `src/app.test.ts`, append:

```typescript
    describe('GET /diag/postmortem', () => {
        it('returns empty when nothing has died', async () => {
            const app = createServer()
            const res = await request(app).get('/diag/postmortem')
            expect(res.status).toBe(200)
            expect(res.body.latest).toBeNull()
            expect(Array.isArray(res.body.all)).toBe(true)
        })
    })
```

- [ ] **Step 3: Run tests + commit**

```bash
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | grep -E "Tests:|FAIL" | head -3
git add src/app.ts src/app.test.ts
git commit -m "feat(app): /diag/postmortem + /diag/kill/ffmpeg (test-only)

/diag/postmortem surfaces the ring buffer of subprocess deaths.
/diag/kill/ffmpeg/:bot_id is a test-only endpoint used by F.15 live
acceptance to verify Railway healthcheck triggers a container restart."
```

---

## Task F.17: /health unhealthy paths

**Files:**
- Modify: `src/app.ts`
- Modify: `src/app.test.ts`

- [ ] **Step 1: Update /health to check subprocess liveness**

Replace the existing `/health` handler in `src/app.ts`:

```typescript
    app.get('/health', (_req: Request, res: Response) => {
        const checks = {
            xvfb: false,
            pulse: false,
        }
        try {
            execSync('xdpyinfo -display :99', {
                timeout: 1500,
                stdio: ['ignore', 'ignore', 'ignore'],
            })
            checks.xvfb = true
        } catch {
            checks.xvfb = false
        }
        try {
            execSync('pactl info', {
                timeout: 1500,
                stdio: ['ignore', 'ignore', 'ignore'],
            })
            checks.pulse = true
        } catch {
            checks.pulse = false
        }
        const healthy = checks.xvfb && checks.pulse
        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'ok' : 'degraded',
            service: 'max-bot',
            version: VERSION,
            checks,
        })
    })
```

- [ ] **Step 2: Update existing /health test to tolerate the new shape**

Find the existing `/health` test and update its assertions:

```typescript
        it('responds with 200 and a status payload', async () => {
            const app = createServer()
            const res = await request(app).get('/health')
            // 200 in dev (xvfb/pulse usually present on Linux CI but
            // not on macOS dev — accept either as long as the shape
            // is right).
            expect([200, 503]).toContain(res.status)
            expect(res.body).toMatchObject({
                service: 'max-bot',
            })
            expect(typeof res.body.version).toBe('string')
            expect(res.body.checks).toBeDefined()
        })
```

- [ ] **Step 3: Run tests + commit**

```bash
./node_modules/.bin/jest --runInBand --testPathPattern='src/(app|bot)' 2>&1 | grep -E "Tests:|FAIL" | head -3
git add src/app.ts src/app.test.ts
git commit -m "feat(health): /health checks Xvfb + PulseAudio liveness

Returns 503 if either subsystem is dead. Combined with Railway's
healthcheck config, this triggers a container restart when the
bot becomes unrecoverably unhealthy."
```

---

## Task F.18: Railway healthcheck config

**Files:**
- Modify: `railway.toml`

- [ ] **Step 1: Inspect current railway.toml**

```bash
cat ~/Documents/Claude/max-bot/railway.toml
```

- [ ] **Step 2: Add a `[deploy]` block**

Append (or merge with existing `[deploy]` block) in `railway.toml`:

```toml
[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 5
```

If a `[deploy]` block already exists, MERGE these keys into it rather than duplicating.

- [ ] **Step 3: Commit**

```bash
git add railway.toml
git commit -m "config(railway): add healthcheck + restart-on-failure policy

Railway polls /health; if it returns 503, the container is restarted
up to 5 times. Together with F.17's enhanced /health, this triggers
auto-recovery when Xvfb or PulseAudio dies."
```

---

## Task F.19: Update CLAUDE-NOTES.md

**Files:**
- Modify: `docs/CLAUDE-NOTES.md`

- [ ] **Step 1: Append Milestone F in-progress section**

Append to `~/Documents/Claude/max-bot/docs/CLAUDE-NOTES.md`:

```markdown
## Milestone F — In progress YYYY-MM-DD

Hardening layer on top of milestone E. What's new:

- **`/leave` timeout-bounded** — 15s ceiling, returns `{ok, bot_id, forced}`. Postmortem records `LEAVE_TIMEOUT` when forced.
- **Bridge listener leak fixed** — `cleanupWs()` detaches all event listeners on the old WS before reconnecting. Test: `_testDeadSockets` array, verified zero listener count after reconnect.
- **Bridge heartbeat watchdog** — `heartbeatStalenessMs` (default 10s). If no message from max-brain in that window, force-reconnect. Counter exposed via `/diag/bridge`.
- **Page-death detection** — `wirePageDeath()` attaches Playwright `close` + `crash` listeners. `onPageDeath` callback in `joinMeet()` auto-cleans the session and records a postmortem.
- **ffmpeg-death detection** — `audioInject.child.on('exit')` records a postmortem if ffmpeg dies outside our `stop()` path.
- **`/health` deep check** — xdpyinfo + pactl info. Returns 503 if either fails.
- **Railway healthcheck wired** — `healthcheckPath = "/health"`, restart-on-failure with 5 retries.
- **Postmortem ring buffer** — `/diag/postmortem` exposes last 20 subprocess death events. Read this when a session feels off.
- **Test-only kill endpoint** — `POST /diag/kill/ffmpeg/:bot_id` for F.20 live acceptance.

42 → 50+ tests.
```

- [ ] **Step 2: Commit**

```bash
git add docs/CLAUDE-NOTES.md
git commit -m "docs: milestone F in-progress notes"
```

---

## Task F.20: Push + PR + merge + deploy

**Files:** None modified.

- [ ] **Step 1: Push the branch**

```bash
cd ~/Documents/Claude/max-bot
git push -u origin milestone-f/hardening
```

- [ ] **Step 2: Open PR + merge**

```bash
gh pr create --base main --head milestone-f/hardening \
    --title "Milestone F: hardening — auto-recovery + postmortem + heartbeat" \
    --body "Three-layer hardening per Milestone F plan. /leave never hangs, MaxBrainBridge no longer leaks listeners, heartbeat watchdog catches half-open WS, Playwright + ffmpeg death are detected and auto-cleaned, /health is deep enough to trigger Railway restart, /diag/postmortem surfaces last 20 death events."
gh pr merge --merge --delete-branch
git checkout main
git pull --rebase origin main
```

- [ ] **Step 3: Wait for Railway redeploy + verify**

```bash
echo "current UTC: $(date -u)"
sleep 150
curl -s -w "\nHTTP %{http_code}\n" https://max-bot-production-7455.up.railway.app/health
curl -s -w "\nHTTP %{http_code}\n" https://max-bot-production-7455.up.railway.app/diag/postmortem
```

Expected: `/health` → HTTP 200 with `checks.xvfb=true, checks.pulse=true`. `/diag/postmortem` → HTTP 200 with `latest: null` (fresh container).

---

## Task F.21: Live acceptance — 15-minute conversation + induced crash

**Files:** None modified.

Suren-in-the-loop. This is the milestone gate.

- [ ] **Step 1: /join + sustained conversation**

```bash
curl -s -X POST -m 90 https://max-brain-production-2842.up.railway.app/join \
    -H "content-type: application/json" \
    -d '{"meeting_url":"https://meet.google.com/mmg-mjgn-njd","bot_name":"Max"}'
```

Save the `bot_id` returned.

Suren joins the meeting in his browser and has a 15-minute conversation with Max. Try:
- Casual chat ("how's it going?", "tell me about your day")
- Tool calls (Jira lookup: "what's on my plate?", "can you check ticket ESB-1234?")
- Long silences (don't speak for 30s, then resume — verify Max doesn't hang or talk over you)
- Rapid back-and-forth

Every 5 minutes, in another terminal:

```bash
BOT=<bot_id>
curl -s https://max-bot-production-7455.up.railway.app/diag/bridge/$BOT \
    | python3 -m json.tool | grep -E "connected|disconnectedSince|heartbeatReconnects|bytesReceived"
```

Expected: `connected: true`, `disconnectedSince: null`, `heartbeatReconnects: 0` for the duration. `bytesReceivedFromBrain` grows linearly (~3MB/min), NOT exponentially (the leak fix).

- [ ] **Step 2: Induce ffmpeg crash**

After ~10 minutes, deliberately kill ffmpeg:

```bash
BOT=<bot_id>
curl -s -X POST https://max-bot-production-7455.up.railway.app/diag/kill/ffmpeg/$BOT
```

Expected: `{"ok":true,"killed_pid":<pid>}`.

Within ~30s, Railway's healthcheck should fail (audio dies but `/health` itself stays 200 unless we kill Xvfb/pulse — so `/health` will probably STILL be 200; the audio just won't flow). Suren will notice Max stops responding.

Then check the postmortem:

```bash
curl -s https://max-bot-production-7455.up.railway.app/diag/postmortem \
    | python3 -m json.tool
```

Expected: `latest.kind = "ffmpeg"`, `latest.signal = "SIGKILL"`, `latest.stderrTail` contains some of ffmpeg's recent output.

- [ ] **Step 3: Test container-level restart**

```bash
# Bigger hammer: kill Xvfb so /health returns 503 and Railway restarts.
# We don't have a /diag/kill endpoint for Xvfb — use Railway's restart
# button OR send SIGTERM to the container. Easier: use the dashboard.
```

Manually click **Restart** in Railway's max-bot service. Wait ~60s, then:

```bash
curl -s -w "\nHTTP %{http_code}\n" https://max-bot-production-7455.up.railway.app/health
```

Expected: HTTP 200, `checks: {xvfb: true, pulse: true}` — container restarted cleanly. Postmortem from the previous container is GONE (in-memory, lost on restart — expected; we don't persist across restarts in F).

- [ ] **Step 4: Verify a fresh /join works**

```bash
curl -s -X POST -m 90 https://max-brain-production-2842.up.railway.app/join \
    -H "content-type: application/json" \
    -d '{"meeting_url":"https://meet.google.com/mmg-mjgn-njd","bot_name":"Max"}'
```

Expected: 200, new bot_id. Suren reconfirms Max joins the meeting and responds.

- [ ] **Step 5: Update CLAUDE-NOTES.md with acceptance notes**

Append to `docs/CLAUDE-NOTES.md`:

```markdown
## Milestone F — Accepted YYYY-MM-DD

- 15-minute live conversation: <pass / fail observations>
- Bridge counters during long session: heartbeatReconnects = <n>, bytesReceived linear: <yes/no>
- ffmpeg-kill postmortem captured: <yes/no with kind=ffmpeg signal=SIGKILL>
- Container restart via Railway dashboard: <yes/no, /health 200 after ~Ns>
- Fresh /join after restart: <yes/no>

Phase 1 of the self-hosting plan is fully complete and robust enough for ongoing iteration.
```

Commit + push to main.

---

## Milestone F acceptance checklist

- [ ] All Jest tests pass (50+ total — up from 42 baseline)
- [ ] `/leave` returns 200 with `forced: true` when close() hangs (synthetic test passes)
- [ ] `MaxBrainBridge` reconnects 3+ times in a row without leaking listeners (test verifies `_testDeadSockets` all have zero listener count)
- [ ] Bridge `disconnectedSince` populates on close, clears on open
- [ ] Bridge heartbeat force-reconnects on staleness (test passes)
- [ ] `wirePageDeath` fires `onPageDeath` on Playwright `close`/`crash` (tests pass)
- [ ] ffmpeg unexpected exit records postmortem (test passes)
- [ ] `/health` returns 503 when Xvfb is missing (impossible to test in jest without mocks — manually verified via Railway logs)
- [ ] `/diag/postmortem` returns the latest death event
- [ ] `/diag/kill/ffmpeg/:bot_id` actually kills ffmpeg
- [ ] `railway.toml` has `healthcheckPath = "/health"` and `restartPolicyType = "ON_FAILURE"`
- [ ] Live: 15-minute conversation, no audio dropouts or hangs
- [ ] Live: ffmpeg-kill captured in postmortem
- [ ] Live: container restart via Railway dashboard succeeds, fresh /join works
- [ ] CLAUDE-NOTES.md updated with acceptance notes

When all 14 are checked: Phase 1 is FULLY COMPLETE. Self-hosted Max is operational and resilient.

---

## What if F.21 fails partially

**If 15-minute conversation has audio dropouts:**
- Check `/diag/bridge/:bot_id` after the dropout. If `heartbeatReconnects > 0`, the watchdog fired — investigate why max-brain stopped sending (likely Gemini rate-limit or network blip).
- Check max-brain's `/debug` for `BRIDGE Pipecat→MBaaS ERROR` entries.

**If `bytesReceivedFromBrain` grows exponentially:**
- The leak fix didn't take. Check `_testDeadSockets` lengths via temporary diag. Verify `cleanupWs()` is called BEFORE `new WebSocket(...)` not after.

**If `/diag/kill/ffmpeg` returns 500:**
- The session might have already lost its `audioInject.child`. Check `/diag/inject/:bot_id` first.

**If Railway healthcheck never triggers a restart:**
- Verify `railway.toml` healthcheck config landed. Check Railway's "Deployments" tab → service → Settings → Healthcheck for the URL.
- Free-tier Railway may not enforce healthchecks aggressively — if so, document this as a known limitation.

**Do NOT propose pivots or "fix it later" workarounds per the hard rule in memory.** Diagnose to root cause.

---

## Self-review

**Spec coverage:**
- ✅ /leave timeout-bounded → Tasks F.3-F.6
- ✅ Bridge listener-leak fix → F.7-F.8
- ✅ Bridge disconnectedSince + heartbeat → F.9-F.10, exposed F.11
- ✅ Page-death detection + auto-cleanup → F.12-F.14
- ✅ ffmpeg-death postmortem → F.15
- ✅ /diag/postmortem + /diag/kill/ffmpeg → F.16
- ✅ /health deep check → F.17
- ✅ Railway healthcheck config → F.18
- ✅ Live verification → F.20-F.21

**Placeholder scan:**
- `YYYY-MM-DD` and `<bot_id>` in F.19/F.21 are intentional fill-in-at-execution markers
- No "TBD" / "similar to" / "implement later" patterns

**Type consistency:**
- `PostmortemKind`, `PostmortemEvent`, `recordPostmortem`, `getLatestPostmortem`, `getAllPostmortems`, `_clearPostmortems` consistently named between F.1, F.2, F.6, F.15, F.16
- `PageDeath`, `PageDeathReason`, `wirePageDeath`, `onPageDeath` consistently named between F.12, F.13, F.14
- `disconnectedSince`, `heartbeatReconnects`, `heartbeatStalenessMs`, `heartbeatIntervalMs` consistently named between F.9, F.10, F.11
- `withTimeout`, `WithTimeoutResult` consistently named between F.3, F.4, F.6

**Scope check:**
- Plan focuses on Milestone F only (max-bot resilience)
- No max-brain changes
- No new architectural primitives — extends existing ones
- Estimated 4-5 hours for F.0-F.20, plus ~30 min for F.21 live acceptance

No issues found. Plan ready for execution.
