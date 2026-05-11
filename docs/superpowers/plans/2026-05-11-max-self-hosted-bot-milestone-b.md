# Max Self-Hosted Bot — Milestone B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /join {meeting_url, bot_name}` causes a Chromium instance inside the max-bot Railway container to navigate to a Google Meet URL, fill in the bot name, click "Ask to join", and stop in the waiting room. The bot is visible as "Max" in the meeting's waiting room to anyone already inside.

**Architecture:** A new `src/bot/joinMeet.ts` module owns the Playwright + Google Meet DOM interaction. It uses Playwright directly and contains a minimal reimplementation of the proven DOM selectors from upstream `src/meeting/meet.ts` (referenced in comments). The HTTP layer in `src/app.ts` exposes `POST /join` that invokes `joinMeet()` and tracks active sessions in an in-memory `Map<bot_id, JoinSession>`. The Dockerfile entrypoint reverts to `/start.sh` (Xvfb + PulseAudio + `node build/src/app.js` at the end) so Chromium has a virtual display to render into.

**Tech Stack:** TypeScript, Node.js 20, Playwright, Chromium, Express, Jest, supertest, Docker, Railway. The `playwright` + `@playwright/test` packages are already declared in `package.json` from upstream.

**Pre-conditions already in place:**
- Milestone A is shipped (commit `e3e9411` on `main`). `/health` returns 200.
- `suren-pm/max-bot` on Railway service `max-bot` (service ID `791b4c57-160b-4192-8981-3285081f81da`) in project `max-self-hosted` is auto-deploying from `main`.
- Live URL: `https://max-bot-production-7455.up.railway.app/health`.
- Upstream meet-teams-bot code (`src/main.ts`, `src/server.ts`, `src/meeting/`, `src/browser/`, `src/state-machine/`) is preserved in the repo, dormant, ready to inform our minimal reimplementation.

**What ships at end of Milestone B:**
- `POST https://max-bot-production-7455.up.railway.app/join` with body `{meeting_url, bot_name}` causes a Chromium instance to join a Google Meet
- Bot "Max" is visible in the TEST meeting's waiting room within 30 seconds
- `GET /health` continues to return 200
- A new `bot_id` (UUID) is returned in the POST response
- `POST /leave/{bot_id}` cleanly tears down the bot's Chromium instance

**Out of scope for Milestone B (deferred to later milestones):**
- Audio capture or injection (Milestones C, D)
- Multiple concurrent bots (Milestone F or never — v1 is single-bot)
- max-brain integration (Milestone E)
- Anti-bot stealth beyond Playwright defaults (Milestone F or Phase 2)
- Auto-cleanup on meeting-ended (Milestone F)
- Webhook callbacks on join success/failure (Milestone E)

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `src/bot/joinMeet.ts` | Create | Self-contained Playwright join function. Owns DOM selectors, browser launch, navigation, name entry, "Ask to join" click, waiting-room detection. Independent of upstream singletons. |
| `src/bot/joinMeet.test.ts` | Create | Jest unit tests for selectors + state transitions. Playwright itself mocked via `jest.mock`. |
| `src/bot/sessions.ts` | Create | In-memory `Map<bot_id, JoinSession>` plus helpers `register`, `get`, `remove`. Tiny, isolated. |
| `src/bot/sessions.test.ts` | Create | Unit tests for session lifecycle (add → get → remove → not-found). |
| `src/app.ts` | Modify | Add `POST /join` and `POST /leave/{bot_id}` routes. Wire to `joinMeet()` and `sessions`. |
| `src/app.test.ts` | Modify | Extend with supertest cases for the new routes. `joinMeet` mocked. |
| `Dockerfile` | Modify | Remove the Milestone-A override `ENTRYPOINT ["node", ...]`. Edit the embedded `/start.sh` heredoc to run `node build/src/app.js` at the end instead of `node build/src/main.js`. |
| `docs/CLAUDE-NOTES.md` | Modify | Append "Milestone B" decisions and gotchas. |

**Files we deliberately do NOT touch in Milestone B:**
- `src/main.ts`, `src/server.ts`, `src/meeting/`, `src/browser/`, `src/state-machine/`, `src/api/`, `src/recording/`, `src/streaming.ts`, `src/singleton.ts`, `src/events.ts`, `src/types.ts`, and everything else from upstream — all stay exactly as they are.

---

## Decisions locked in for Milestone B

- **Minimal reimplementation, not reuse, of upstream Meet logic.** `MeetProvider` in `src/meeting/meet.ts` is tightly coupled to `GLOBAL` singleton, `MeetingStateMachine.instance`, and the recording lifecycle. Reusing it would pull in nearly the whole framework. Instead, `src/bot/joinMeet.ts` is a self-contained Playwright + Meet driver that copies the DOM selectors from upstream (with `// from src/meeting/meet.ts:866` comments so they're traceable). The two implementations may diverge over time; that's acceptable.
- **In-process Playwright, not child-process.** Spawning `node build/src/main.js` per join is the alternative. Rejected because: (a) main.ts assumes single-shot lifecycle and exits after recording, (b) main.ts's internal `server()` on port 8080 would collide with `app.ts`, (c) Playwright runs fine in-process and the upstream code does so itself anyway.
- **Single bot at a time.** v1 scope. `sessions.ts` Map is a single entry in practice; we'll error on the second concurrent `/join` with HTTP 409.
- **Restore `/start.sh` as Docker ENTRYPOINT.** Milestone A appended a bare `ENTRYPOINT ["node", "build/src/app.js"]` to skip Xvfb/PulseAudio. Milestone B needs Xvfb because Playwright Chromium has to render somewhere. So we revert that ENTRYPOINT and modify the existing `/start.sh` heredoc to run `node build/src/app.js` at its end instead of `node build/src/main.js`.
- **Bot waits in the waiting room. We do NOT poll for admission in Milestone B.** Acceptance is "bot visible in waiting room within 30s". Milestone C/D will handle the admitted state.
- **TEST meeting URL is passed in the request body**, not hard-coded. Suren creates a fresh Google Meet, sends `POST /join` with that URL.

---

## Pre-work — branch setup

### Task B.0: Branch from `main`

**Files:** None modified in this task; setup only.

- [ ] **Step 1: Pull latest main and create a branch**

```bash
cd ~/Documents/Claude/max-bot
git checkout main
git pull origin main
git checkout -b milestone-b/playwright-join
```

Expected: clean working tree, branch created off latest main.

- [ ] **Step 2: Verify Node + npm setup**

```bash
source ~/.nvm/nvm.sh && nvm use 20
unset NODE_ENV
node --version  # expected: v20.x
ls node_modules/.bin/jest  # expected: file exists
ls node_modules/playwright  # expected: directory exists
```

If `jest` or `playwright` is missing: `npm ci --include=dev`.

If `NODE_ENV=production` is set in the shell, `npm ci` will skip dev deps silently. Always `unset NODE_ENV` first locally.

- [ ] **Step 3: Confirm baseline tests pass**

```bash
./node_modules/.bin/jest src/app.test.ts --runInBand 2>&1 | tail -10
```

Expected: 1 passing test (`responds with 200 and a status payload`).

---

## Task B.1: Revert the Milestone-A ENTRYPOINT override; route `/start.sh` to `app.js`

**Files:**
- Modify: `Dockerfile`

The goal: `/start.sh` is back as the entrypoint, so Xvfb + PulseAudio + Chromium are ready when `app.ts` boots. The final line of the embedded `/start.sh` heredoc needs to change from `node build/src/main.js` to `node build/src/app.js`.

- [ ] **Step 1: Re-read the current Dockerfile to locate the override**

```bash
grep -n "ENTRYPOINT\|EXPOSE 8080" Dockerfile
```

Expected: shows `ENTRYPOINT ["/start.sh"]` and `ENTRYPOINT ["node", "build/src/app.js"]` and `EXPOSE 8080` lines.

- [ ] **Step 2: Remove the Milestone-A override block**

Edit `Dockerfile`. Find this block (added at the end of the file in Milestone A) and remove the final `ENTRYPOINT` line, but **keep** `EXPOSE 8080`:

```dockerfile
# Remove this block of comments + the override ENTRYPOINT line:
# ---------------------------------------------------------------------------
# Max-Bot Milestone A: HTTP server entrypoint override
# ...
# ---------------------------------------------------------------------------

EXPOSE 8080
ENTRYPOINT ["node", "build/src/app.js"]   # ← remove this final line; keep EXPOSE 8080
```

After edit, the file should end with the original `ENTRYPOINT ["/start.sh"]` (line 110 in upstream) followed by a new `EXPOSE 8080` directive. Replace the Milestone-A comment block with a shorter note:

```dockerfile
# Max-Bot: expose port 8080 so Railway can route HTTP traffic to app.ts.
EXPOSE 8080
```

- [ ] **Step 3: Edit the heredoc inside the RUN that creates /start.sh**

In the Dockerfile, the embedded heredoc near the bottom contains:

```
# Start application\ncd /app/\nnode build/src/main.js\n
```

Change `node build/src/main.js` to `node build/src/app.js` in that one line. Search and replace within the heredoc only — do not touch any other reference to `main.js` (there are none elsewhere). The simplest correctness check after edit:

```bash
grep -n "build/src/" Dockerfile
```

Expected: one match, on the heredoc line, showing `node build/src/app.js`.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "build(docker): restore /start.sh entrypoint, route to app.js

Milestone A skipped Xvfb + PulseAudio because /health doesn't need
display or audio. Milestone B needs Playwright Chromium to render,
so the original /start.sh entrypoint is restored. The heredoc's final
'node build/src/main.js' is rewritten to 'node build/src/app.js' so the
new HTTP server is what the long-lived script execs.

The EXPOSE 8080 directive is preserved."
```

---

## Task B.2: Local Docker smoke test (optional but recommended)

**Files:** None modified.

This is a confidence check that the Dockerfile change still produces a working `/health`. The image is heavy (Ubuntu + Playwright + AWS CLI) so this takes ~5–10 minutes. Skip this task if Docker Desktop is unavailable; rely on Railway as the verification step instead.

- [ ] **Step 1: Build the image**

```bash
cd ~/Documents/Claude/max-bot
docker build -t max-bot:milestone-b .
```

Expected: image builds successfully.

- [ ] **Step 2: Run the image with port mapping**

```bash
docker run --rm -d --name max-bot-smoke -p 8080:8080 max-bot:milestone-b
sleep 20  # Xvfb + PulseAudio + node startup
docker logs max-bot-smoke | tail -20
curl -s http://localhost:8080/health
docker stop max-bot-smoke
```

Expected output of curl:

```
{"status":"ok","service":"max-bot","version":"0.1.0"}
```

Expected log lines include `✅ Virtual display and audio ready` and `max-bot listening on :8080`.

---

## Task B.3: Sessions module — failing test (TDD red)

**Files:**
- Create: `src/bot/sessions.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// src/bot/sessions.test.ts
import { registerSession, getSession, removeSession, hasActiveSession, JoinSession } from './sessions'

describe('bot/sessions', () => {
    afterEach(() => {
        // Tests share module state; clear between cases.
        // We expose removeSession; tests should be additive-friendly.
    })

    it('registers and retrieves a session by bot_id', () => {
        const session: JoinSession = {
            bot_id: 'bot-1',
            meeting_url: 'https://meet.google.com/abc-defg-hij',
            bot_name: 'Max',
            startedAt: new Date('2026-05-11T00:00:00Z'),
            close: jest.fn(async () => {}),
        }
        registerSession(session)
        expect(getSession('bot-1')).toBe(session)
        removeSession('bot-1')
    })

    it('returns undefined for unknown bot_id', () => {
        expect(getSession('nope')).toBeUndefined()
    })

    it('reports active session presence', () => {
        expect(hasActiveSession()).toBe(false)
        registerSession({
            bot_id: 'bot-2',
            meeting_url: 'https://meet.google.com/xyz',
            bot_name: 'Max',
            startedAt: new Date(),
            close: jest.fn(async () => {}),
        })
        expect(hasActiveSession()).toBe(true)
        removeSession('bot-2')
        expect(hasActiveSession()).toBe(false)
    })

    it('removeSession is a no-op for unknown bot_id', () => {
        expect(() => removeSession('nope')).not.toThrow()
    })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
./node_modules/.bin/jest src/bot/sessions.test.ts --runInBand 2>&1 | tail -15
```

Expected: FAIL — "Cannot find module './sessions'".

---

## Task B.4: Sessions module — passing implementation (TDD green)

**Files:**
- Create: `src/bot/sessions.ts`

- [ ] **Step 1: Create the implementation**

```typescript
// src/bot/sessions.ts
//
// Tiny in-memory registry of currently-active join sessions.
//
// Milestone B scope is single-bot, but the API is shaped as a Map so
// later milestones can lift the "one active bot" restriction without
// rewriting callers.

export interface JoinSession {
    bot_id: string
    meeting_url: string
    bot_name: string
    startedAt: Date
    /** Resolves when the underlying Playwright resources are torn down. */
    close: () => Promise<void>
}

const sessions = new Map<string, JoinSession>()

export function registerSession(session: JoinSession): void {
    sessions.set(session.bot_id, session)
}

export function getSession(bot_id: string): JoinSession | undefined {
    return sessions.get(bot_id)
}

export function removeSession(bot_id: string): void {
    sessions.delete(bot_id)
}

export function hasActiveSession(): boolean {
    return sessions.size > 0
}

/** Test-only escape hatch — clears all sessions. Not exported via index. */
export function _clearAllSessions(): void {
    sessions.clear()
}
```

- [ ] **Step 2: Run the test and verify it passes**

```bash
./node_modules/.bin/jest src/bot/sessions.test.ts --runInBand 2>&1 | tail -10
```

Expected: `Tests: 4 passed, 4 total`.

- [ ] **Step 3: Commit**

```bash
git add src/bot/sessions.ts src/bot/sessions.test.ts
git commit -m "feat(bot): sessions registry for tracking active bots

Tiny in-memory Map<bot_id, JoinSession>. Single-bot in Milestone B
but API shaped to scale to many. close() handle on each session lets
/leave tear down the Chromium instance later."
```

---

## Task B.5: joinMeet — failing test (TDD red)

**Files:**
- Create: `src/bot/joinMeet.test.ts`

We test the orchestration logic, not Playwright itself. Playwright is mocked.

- [ ] **Step 1: Create the test file**

```typescript
// src/bot/joinMeet.test.ts
import { joinMeet, JoinResult } from './joinMeet'

// Mock playwright so the unit tests don't try to launch Chromium.
jest.mock('playwright', () => {
    const fillMock = jest.fn(async () => {})
    const clickMock = jest.fn(async () => {})
    const gotoMock = jest.fn(async () => ({ status: () => 200 }))
    const waitForSelectorMock = jest.fn(async () => ({}))
    const closeMock = jest.fn(async () => {})
    const newPageMock = jest.fn(async () => ({
        goto: gotoMock,
        fill: fillMock,
        click: clickMock,
        waitForSelector: waitForSelectorMock,
        locator: jest.fn(() => ({ fill: fillMock, click: clickMock })),
        close: closeMock,
    }))
    const newContextMock = jest.fn(async () => ({
        newPage: newPageMock,
        close: closeMock,
        grantPermissions: jest.fn(async () => {}),
    }))
    const launchMock = jest.fn(async () => ({
        newContext: newContextMock,
        close: closeMock,
    }))
    return {
        chromium: {
            launch: launchMock,
        },
        __mocks__: { launchMock, newContextMock, newPageMock, gotoMock, fillMock, clickMock, waitForSelectorMock, closeMock },
    }
})

import * as playwright from 'playwright'
const mocks = (playwright as any).__mocks__

describe('joinMeet', () => {
    beforeEach(() => {
        Object.values(mocks).forEach((m: any) => m.mockClear?.())
    })

    it('launches Chromium, navigates to the meeting URL, types the bot name, clicks join, and returns bot_id', async () => {
        const result: JoinResult = await joinMeet({
            meeting_url: 'https://meet.google.com/abc-defg-hij',
            bot_name: 'Max',
        })

        expect(result.bot_id).toMatch(/^[0-9a-f-]{36}$/)
        expect(mocks.launchMock).toHaveBeenCalled()
        expect(mocks.gotoMock).toHaveBeenCalledWith(
            'https://meet.google.com/abc-defg-hij',
            expect.objectContaining({ waitUntil: expect.any(String) }),
        )
        // Bot name should have been typed somewhere in the flow.
        expect(mocks.fillMock).toHaveBeenCalledWith(expect.anything(), 'Max')
        // Join CTA should have been clicked.
        expect(mocks.clickMock).toHaveBeenCalled()
    })

    it('returns a close() handle that tears down the browser', async () => {
        const result = await joinMeet({
            meeting_url: 'https://meet.google.com/abc-defg-hij',
            bot_name: 'Max',
        })
        await result.close()
        expect(mocks.closeMock).toHaveBeenCalled()
    })

    it('throws if meeting_url is not a Google Meet URL', async () => {
        await expect(
            joinMeet({
                meeting_url: 'https://teams.microsoft.com/foo',
                bot_name: 'Max',
            }),
        ).rejects.toThrow(/google meet/i)
    })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
./node_modules/.bin/jest src/bot/joinMeet.test.ts --runInBand 2>&1 | tail -15
```

Expected: FAIL — "Cannot find module './joinMeet'".

---

## Task B.6: joinMeet — passing implementation (TDD green)

**Files:**
- Create: `src/bot/joinMeet.ts`

- [ ] **Step 1: Create the implementation**

```typescript
// src/bot/joinMeet.ts
//
// Self-contained Playwright + Google Meet "join the waiting room" flow.
//
// The DOM selectors and timeouts below are copied from upstream
// src/meeting/meet.ts (`MeetProvider` and helpers). We do NOT import
// from src/meeting/* — that code is tightly coupled to GLOBAL singleton
// and the recording state machine. For Milestone B we only need to
// reach the waiting room, so a minimal reimplementation is cleaner.
//
// References:
// - src/meeting/meet.ts:43      MeetProvider.openMeetingPage
// - src/meeting/meet.ts:866-879 "Ask to join" / "Join now" selectors
// - src/meeting/meet.ts:1125-1145 typeBotName helper
// - src/meeting/meet.ts:847     isInWaitingRoom helper

import { randomUUID } from 'crypto'
import { chromium, Browser, BrowserContext, Page } from 'playwright'

export interface JoinMeetParams {
    meeting_url: string
    bot_name: string
}

export interface JoinResult {
    bot_id: string
    /** Tears down the Chromium browser + context. Idempotent. */
    close: () => Promise<void>
}

const NAME_INPUT_SELECTORS = [
    'input[aria-label="Your name"]',
    'input[type="text"][placeholder*="name" i]',
    'input[jsname][type="text"]',
]

const JOIN_BUTTON_SELECTORS = [
    'button:has-text("Ask to join")',
    'button:has-text("Join now")',
    'span:has-text("Ask to join")',
    'button[aria-label*="join now" i]',
    'button[aria-label*="Ask to join" i]',
]

function isGoogleMeetUrl(url: string): boolean {
    try {
        const parsed = new URL(url)
        return parsed.hostname === 'meet.google.com'
    } catch {
        return false
    }
}

async function fillBotName(page: Page, bot_name: string): Promise<void> {
    // Try each selector in order; first match wins.
    for (const selector of NAME_INPUT_SELECTORS) {
        const input = page.locator(selector).first()
        try {
            await input.waitFor({ state: 'visible', timeout: 5000 })
            await input.fill(bot_name)
            return
        } catch {
            // Try next selector.
        }
    }
    throw new Error('Could not find the bot-name input on Google Meet')
}

async function clickJoinCta(page: Page): Promise<void> {
    for (const selector of JOIN_BUTTON_SELECTORS) {
        const button = page.locator(selector).first()
        try {
            await button.waitFor({ state: 'visible', timeout: 5000 })
            await button.click()
            return
        } catch {
            // Try next selector.
        }
    }
    throw new Error('Could not find the "Ask to join" / "Join now" button on Google Meet')
}

export async function joinMeet(params: JoinMeetParams): Promise<JoinResult> {
    if (!isGoogleMeetUrl(params.meeting_url)) {
        throw new Error(
            `joinMeet only supports Google Meet URLs; got: ${params.meeting_url}`,
        )
    }

    const bot_id = randomUUID()

    // Headful Chrome: Xvfb provides the display inside the container.
    const browser: Browser = await chromium.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--use-fake-ui-for-media-stream',
        ],
    })

    const context: BrowserContext = await browser.newContext()
    // Grant mic + camera so Meet's pre-join screen doesn't prompt.
    await context.grantPermissions(['camera', 'microphone'], {
        origin: 'https://meet.google.com',
    })

    const page = await context.newPage()
    await page.goto(params.meeting_url, {
        waitUntil: 'networkidle',
        timeout: 30000,
    })

    await fillBotName(page, params.bot_name)
    await clickJoinCta(page)

    // At this point the bot has clicked "Ask to join" and will sit in
    // the waiting room until someone admits it. Milestone B's acceptance
    // is "bot visible in waiting room within 30s", so we return now.

    const close = async (): Promise<void> => {
        try {
            await page.close()
        } catch {
            /* ignore */
        }
        try {
            await context.close()
        } catch {
            /* ignore */
        }
        try {
            await browser.close()
        } catch {
            /* ignore */
        }
    }

    return { bot_id, close }
}
```

- [ ] **Step 2: Run the test and verify it passes**

```bash
./node_modules/.bin/jest src/bot/joinMeet.test.ts --runInBand 2>&1 | tail -15
```

Expected: `Tests: 3 passed, 3 total`.

- [ ] **Step 3: Commit**

```bash
git add src/bot/joinMeet.ts src/bot/joinMeet.test.ts
git commit -m "feat(bot): joinMeet — Playwright + Google Meet waiting-room flow

Minimal reimplementation of the upstream MeetProvider join logic.
Self-contained: no imports from src/meeting/*, no dependence on
GLOBAL singleton or MeetingStateMachine. Selectors copied from
src/meeting/meet.ts with line references in comments.

Acceptance for Milestone B is 'bot visible in waiting room' — we
click 'Ask to join' and return immediately, no polling for admission."
```

---

## Task B.7: app.ts — failing tests for /join and /leave (TDD red)

**Files:**
- Modify: `src/app.test.ts`

- [ ] **Step 1: Replace the contents of `src/app.test.ts` with this expanded version**

```typescript
import request from 'supertest'

import { createServer } from './app'
import * as joinMeetModule from './bot/joinMeet'
import { _clearAllSessions } from './bot/sessions'

describe('max-bot HTTP server', () => {
    afterEach(() => {
        jest.restoreAllMocks()
        _clearAllSessions()
    })

    describe('GET /health', () => {
        it('responds with 200 and a status payload', async () => {
            const app = createServer()
            const res = await request(app).get('/health')
            expect(res.status).toBe(200)
            expect(res.body).toMatchObject({
                status: 'ok',
                service: 'max-bot',
            })
            expect(typeof res.body.version).toBe('string')
        })
    })

    describe('POST /join', () => {
        it('returns 200 with a bot_id when joinMeet succeeds', async () => {
            const fakeClose = jest.fn(async () => {})
            jest.spyOn(joinMeetModule, 'joinMeet').mockResolvedValue({
                bot_id: '11111111-1111-1111-1111-111111111111',
                close: fakeClose,
            })

            const app = createServer()
            const res = await request(app)
                .post('/join')
                .send({
                    meeting_url: 'https://meet.google.com/abc-defg-hij',
                    bot_name: 'Max',
                })

            expect(res.status).toBe(200)
            expect(res.body).toMatchObject({
                bot_id: '11111111-1111-1111-1111-111111111111',
            })
        })

        it('returns 400 when meeting_url is missing', async () => {
            const app = createServer()
            const res = await request(app).post('/join').send({ bot_name: 'Max' })
            expect(res.status).toBe(400)
            expect(res.body.error).toMatch(/meeting_url/)
        })

        it('returns 400 when bot_name is missing', async () => {
            const app = createServer()
            const res = await request(app).post('/join').send({
                meeting_url: 'https://meet.google.com/abc-defg-hij',
            })
            expect(res.status).toBe(400)
            expect(res.body.error).toMatch(/bot_name/)
        })

        it('returns 409 when another bot is already active', async () => {
            jest.spyOn(joinMeetModule, 'joinMeet').mockResolvedValue({
                bot_id: '22222222-2222-2222-2222-222222222222',
                close: jest.fn(async () => {}),
            })

            const app = createServer()
            const first = await request(app).post('/join').send({
                meeting_url: 'https://meet.google.com/abc-defg-hij',
                bot_name: 'Max',
            })
            expect(first.status).toBe(200)

            const second = await request(app).post('/join').send({
                meeting_url: 'https://meet.google.com/xyz-wxyz-uvw',
                bot_name: 'MaxToo',
            })
            expect(second.status).toBe(409)
        })

        it('returns 500 when joinMeet rejects', async () => {
            jest.spyOn(joinMeetModule, 'joinMeet').mockRejectedValue(
                new Error('boom'),
            )

            const app = createServer()
            const res = await request(app).post('/join').send({
                meeting_url: 'https://meet.google.com/abc-defg-hij',
                bot_name: 'Max',
            })
            expect(res.status).toBe(500)
            expect(res.body.error).toMatch(/boom/)
        })
    })

    describe('POST /leave/:bot_id', () => {
        it('returns 200 and calls close() on the active session', async () => {
            const closeMock = jest.fn(async () => {})
            jest.spyOn(joinMeetModule, 'joinMeet').mockResolvedValue({
                bot_id: '33333333-3333-3333-3333-333333333333',
                close: closeMock,
            })

            const app = createServer()
            const joinRes = await request(app).post('/join').send({
                meeting_url: 'https://meet.google.com/abc-defg-hij',
                bot_name: 'Max',
            })
            const { bot_id } = joinRes.body

            const leaveRes = await request(app).post(`/leave/${bot_id}`)
            expect(leaveRes.status).toBe(200)
            expect(closeMock).toHaveBeenCalled()
        })

        it('returns 404 for an unknown bot_id', async () => {
            const app = createServer()
            const res = await request(app).post('/leave/does-not-exist')
            expect(res.status).toBe(404)
        })
    })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
./node_modules/.bin/jest src/app.test.ts --runInBand 2>&1 | tail -20
```

Expected: multiple FAILs, all due to missing `/join` and `/leave` routes returning 404 instead of expected status codes.

---

## Task B.8: app.ts — implement /join and /leave (TDD green)

**Files:**
- Modify: `src/app.ts`

- [ ] **Step 1: Replace the contents of `src/app.ts` with this expanded version**

```typescript
// Top-level long-running HTTP service entrypoint for the self-hosted max-bot.
//
// Milestone A: /health
// Milestone B: + POST /join, POST /leave/:bot_id
// Later milestones will add WebSocket /ws/{bot_id} for audio.
//
// Note: `src/server.ts` already exists in this repo from upstream
// meet-teams-bot — that's the in-recording control plane invoked
// from main.ts. We deliberately do NOT touch it. This file is a
// separate, new entrypoint.

import express, { Application, Request, Response } from 'express'

import { joinMeet } from './bot/joinMeet'
import {
    getSession,
    hasActiveSession,
    registerSession,
    removeSession,
} from './bot/sessions'

const VERSION = '0.1.0'

export function createServer(): Application {
    const app = express()
    app.use(express.json())

    app.get('/health', (_req: Request, res: Response) => {
        res.status(200).json({
            status: 'ok',
            service: 'max-bot',
            version: VERSION,
        })
    })

    app.post('/join', async (req: Request, res: Response) => {
        const { meeting_url, bot_name } = req.body ?? {}

        if (typeof meeting_url !== 'string' || meeting_url.length === 0) {
            res.status(400).json({
                error: 'meeting_url is required and must be a non-empty string',
            })
            return
        }
        if (typeof bot_name !== 'string' || bot_name.length === 0) {
            res.status(400).json({
                error: 'bot_name is required and must be a non-empty string',
            })
            return
        }
        if (hasActiveSession()) {
            res.status(409).json({
                error: 'max-bot is already in a meeting; only one bot at a time is supported in v1',
            })
            return
        }

        try {
            const { bot_id, close } = await joinMeet({
                meeting_url,
                bot_name,
            })
            registerSession({
                bot_id,
                meeting_url,
                bot_name,
                startedAt: new Date(),
                close,
            })
            res.status(200).json({ bot_id })
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            res.status(500).json({ error: message })
        }
    })

    app.post('/leave/:bot_id', async (req: Request, res: Response) => {
        const { bot_id } = req.params
        const session = getSession(bot_id)
        if (!session) {
            res.status(404).json({ error: `no active session for bot_id=${bot_id}` })
            return
        }
        try {
            await session.close()
        } catch (err) {
            // Log but still treat as successful — the goal is to forget the bot.
            const message = err instanceof Error ? err.message : String(err)
            // eslint-disable-next-line no-console
            console.warn(`close() threw during /leave/${bot_id}: ${message}`)
        }
        removeSession(bot_id)
        res.status(200).json({ ok: true, bot_id })
    })

    return app
}

// Allow running directly: `node build/src/app.js` on Railway.
// PORT is provided by Railway; default 8080 for local dev.
if (require.main === module) {
    const port = Number(process.env.PORT) || 8080
    const app = createServer()
    app.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`max-bot listening on :${port}`)
    })
}
```

- [ ] **Step 2: Run the full test file and verify all pass**

```bash
./node_modules/.bin/jest src/app.test.ts --runInBand 2>&1 | tail -15
```

Expected: `Tests: 8 passed, 8 total` (1 health + 5 join + 2 leave).

- [ ] **Step 3: Run all repo tests as a regression check**

```bash
./node_modules/.bin/jest --runInBand 2>&1 | tail -15
```

Expected: all tests pass. Existing tests we haven't touched should remain green; if any upstream test breaks, that's a signal we accidentally broke something in shared infrastructure — investigate before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/app.ts src/app.test.ts
git commit -m "feat(app): POST /join and POST /leave/:bot_id routes

POST /join {meeting_url, bot_name} → spawns Playwright Chromium,
fills name, clicks 'Ask to join', returns {bot_id}. 400 on missing
fields, 409 when another bot is already active, 500 on Playwright
failure.

POST /leave/:bot_id → tears down the Chromium instance and forgets
the session. 404 if bot_id is unknown."
```

---

## Task B.9: Update CLAUDE-NOTES.md

**Files:**
- Modify: `docs/CLAUDE-NOTES.md`

- [ ] **Step 1: Append a "Milestone B — in progress" section before merging**

Open `docs/CLAUDE-NOTES.md` and append at the end:

```markdown
## Milestone B — POST /join + Playwright waiting-room flow

### What's added

- `src/bot/joinMeet.ts` — self-contained Playwright + Google Meet driver
- `src/bot/sessions.ts` — in-memory Map<bot_id, JoinSession>
- `POST /join` and `POST /leave/:bot_id` routes in `src/app.ts`
- Dockerfile: reverted Milestone-A `ENTRYPOINT ["node", ...]` override; `/start.sh` heredoc rewritten to run `node build/src/app.js` at the end

### Decisions made during the milestone

- **Minimal reimplementation, not reuse, of upstream Meet logic.** `src/meeting/meet.ts` is tightly coupled to `GLOBAL` singleton and the recording state machine. Reusing it would pull in the whole framework. `src/bot/joinMeet.ts` copies the DOM selectors with source references in comments.
- **In-process Playwright, not child-process.** Spawning main.ts per join would collide with its internal port-8080 server() and assumes single-shot lifecycle. In-process is simpler and matches upstream's own usage pattern.
- **Single bot at a time.** POST /join returns 409 if another session is active. v1 scope.

### Gotchas

- (Fill in as encountered during execution.)
```

- [ ] **Step 2: Commit**

```bash
git add docs/CLAUDE-NOTES.md
git commit -m "docs: milestone B in-progress notes"
```

---

## Task B.10: Push branch, open PR, merge to main

**Files:** None modified.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin milestone-b/playwright-join 2>&1 | tail -5
```

- [ ] **Step 2: Open the PR via gh**

```bash
gh pr create \
  --base main \
  --head milestone-b/playwright-join \
  --title "Milestone B: POST /join + Playwright Google Meet waiting room" \
  --body "Adds the Playwright join flow on top of Milestone A's HTTP skeleton.

## Changes

- \`src/bot/joinMeet.ts\` — self-contained Playwright + Meet driver
- \`src/bot/sessions.ts\` — in-memory bot session registry
- \`src/app.ts\` — POST /join, POST /leave/:bot_id
- \`Dockerfile\` — reverted Milestone-A entrypoint override; \`/start.sh\` heredoc now exec's \`node build/src/app.js\` so Xvfb + PulseAudio + Chromium are ready when the HTTP server boots

## What is untouched

- \`src/main.ts\`, \`src/server.ts\`, \`src/meeting/\`, \`src/browser/\`, \`src/state-machine/\` and everything else from upstream meet-teams-bot

## Acceptance

After merge + Railway deploy: Suren creates a Google Meet, runs

\`\`\`bash
curl -X POST https://max-bot-production-7455.up.railway.app/join \\
  -H 'content-type: application/json' \\
  -d '{\"meeting_url\":\"<URL>\",\"bot_name\":\"Max\"}'
\`\`\`

and within 30s sees \"Max\" appear in the meeting's waiting room.

Milestones C–F (audio capture, audio injection, max-brain integration, hardening) build on this."
```

- [ ] **Step 3: Merge the PR**

```bash
gh pr merge --merge --delete-branch
git checkout main
git pull
```

Expected: PR merged, branch deleted, local main current.

- [ ] **Step 4: Wait for Railway to deploy + verify /health still works**

```bash
sleep 60  # Railway needs time for the heavier Dockerfile build (Playwright)
for i in 1 2 3 4 5; do
    echo "--- attempt $i ---"
    HTTP=$(curl -s -o /tmp/h -w "%{http_code}" --max-time 15 \
        https://max-bot-production-7455.up.railway.app/health)
    echo "HTTP $HTTP — $(cat /tmp/h)"
    [ "$HTTP" = "200" ] && break
    sleep 30
done
```

Expected within ~5–10 minutes of merge: HTTP 200, JSON `{"status":"ok",...}`.

If the deploy fails: check Railway dashboard → max-bot → Deployments → View logs. The most likely failure is /start.sh timing — Xvfb + PulseAudio + node startup might exceed the 60s healthcheck timeout in `railway.toml`. If so, bump it to 120s in railway.toml and re-PR.

---

## Task B.11: Live TEST meeting acceptance test

**Files:** None modified.

This is the actual milestone acceptance check. Manual, with Suren observing.

- [ ] **Step 1: Suren creates a fresh Google Meet meeting**

In a Chrome tab signed in as Suren's Everperform account, click "New meeting" → "Start an instant meeting". Copy the URL (format `https://meet.google.com/abc-defg-hij`).

- [ ] **Step 2: Send the POST /join request**

```bash
MEETING_URL="https://meet.google.com/abc-defg-hij"  # ← replace with actual URL
curl -X POST https://max-bot-production-7455.up.railway.app/join \
    -H 'content-type: application/json' \
    -d "{\"meeting_url\":\"${MEETING_URL}\",\"bot_name\":\"Max\"}"
```

Expected: HTTP 200, response body `{"bot_id":"<uuid>"}`. Note the bot_id.

- [ ] **Step 3: Watch the Meet waiting room**

Within 30 seconds, a participant named "Max" should appear in the "Waiting to join" section of Suren's Meet UI.

If the bot doesn't appear:
- Check Railway logs (`railway logs --service max-bot` if CLI authed, else dashboard) for Playwright errors
- Most likely cause: Meet's DOM selectors changed since upstream meet.ts. Update `NAME_INPUT_SELECTORS` and `JOIN_BUTTON_SELECTORS` in `src/bot/joinMeet.ts` to match the current DOM
- Second-most-likely: anti-bot detection (Google flags the headless-ish browser). Workaround in Phase 2; for Milestone B, capture a screenshot of whatever Google IS showing the bot — that's still useful data.

- [ ] **Step 4: Screenshot for the record**

Suren takes a screenshot of the waiting room showing "Max" requesting to join. Save to `docs/screenshots/milestone-b-waiting-room.png` (create the directory if needed).

- [ ] **Step 5: Tear down the bot**

```bash
BOT_ID="<uuid from step 2>"
curl -X POST https://max-bot-production-7455.up.railway.app/leave/${BOT_ID}
```

Expected: HTTP 200, `{"ok":true,"bot_id":"<uuid>"}`.

- [ ] **Step 6: Update CLAUDE-NOTES.md with the result**

Append to the Milestone B section:

```markdown
### Acceptance — DATE

- Live TEST meeting URL: <URL>
- bot_id: <uuid>
- Time-to-waiting-room: <Ns>
- Screenshot: docs/screenshots/milestone-b-waiting-room.png
- Gotchas hit during live test: <list>
```

Commit + push to main:

```bash
git add docs/CLAUDE-NOTES.md docs/screenshots/
git commit -m "docs: milestone B live acceptance test passed"
git push
```

---

## Milestone B acceptance checklist

- [ ] All Jest tests pass locally (`./node_modules/.bin/jest --runInBand`)
- [ ] Railway deploy of the merged branch lands `ACTIVE` and `/health` returns 200
- [ ] `POST /join` with a real Meet URL returns 200 + bot_id
- [ ] Bot "Max" visible in the waiting room of the TEST meeting within 30s
- [ ] `POST /leave/:bot_id` returns 200 and Chromium is gone (verify with `docker exec` or by observing the Meet UI — bot disappears from waiting room)
- [ ] `docs/CLAUDE-NOTES.md` documents what was done and any decisions/gotchas
- [ ] Screenshot stored in `docs/screenshots/milestone-b-waiting-room.png`

When all are checked, Milestone B is complete and we are ready to start Milestone C (audio capture out).

---

## Self-review

**Spec coverage:**
- ✅ Milestone B goal from the original spec ("Playwright joins a real Google Meet URL with bot_name=Max. Screenshot confirms bot in waiting room of TEST meeting") is the explicit acceptance criterion of Task B.11.
- ✅ Plan addresses all `Likely shape` bullets from the Milestone A plan's Milestone B section, with one deliberate substitution: we use `src/bot/joinMeet.ts` (not `src/bot/joinMeet.ts` calling upstream code) — minimal reimplementation rationale documented above.
- ✅ Existing-code-untouched principle preserved.

**Placeholder scan:**
- The "Gotchas" subsection in CLAUDE-NOTES.md (Task B.9) is intentionally a fill-in-during-execution template, like in Milestone A's plan. Not a placeholder failure.
- Live test step uses `<URL>`, `<uuid>`, `<Ns>`, `<list>` as placeholders for runtime values entered by the executor. Standard.

**Type consistency:**
- `JoinSession` interface defined in `src/bot/sessions.ts` (Task B.4) — matches usage in `src/app.ts` (Task B.8) and tests (B.3, B.7).
- `JoinResult` defined in `src/bot/joinMeet.ts` (Task B.6) — `{bot_id: string, close: () => Promise<void>}` — matches usage in `src/app.ts` (Task B.8).
- All `POST /join` / `POST /leave/:bot_id` request/response shapes are consistent between tests (B.7) and implementation (B.8).

**Scope check:**
- Plan focused on Milestone B only.
- Acceptance criterion concrete and testable.
- Estimate: 3–5 days per the design spec.
