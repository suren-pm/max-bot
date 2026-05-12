// Self-contained Playwright + Google Meet "join the waiting room" flow.
//
// The DOM selectors below are inspired by upstream src/meeting/meet.ts
// (`MeetProvider` and helpers). We do NOT import from src/meeting/* —
// that code is tightly coupled to the GLOBAL singleton and the recording
// state machine. For Milestone B we only need to reach the waiting room,
// so a minimal reimplementation is cleaner.
//
// References:
// - src/meeting/meet.ts:43      MeetProvider.openMeetingPage
// - src/meeting/meet.ts:866-879 "Ask to join" / "Join now" selectors
// - src/meeting/meet.ts:1125    typeBotName helper
// - src/meeting/meet.ts:847     isInWaitingRoom helper

import * as crypto from 'crypto'
import {
    Browser,
    BrowserContext,
    chromium,
    LaunchOptions,
    Page,
} from 'playwright'

// node 16+ has crypto.randomUUID(), but upstream's @types/node is pinned
// at 14.x, so we cast around the missing type declaration.
const randomUUID = (crypto as unknown as { randomUUID: () => string })
    .randomUUID

export interface JoinMeetParams {
    meeting_url: string
    bot_name: string
    /**
     * Optional hook invoked after the Playwright Page is created but
     * BEFORE we navigate to the meeting URL. Use this for setting up
     * inject scripts (e.g. attachAudioCapture) that need to be in place
     * before Meet's own JavaScript runs — including its RTCPeerConnection
     * constructor calls.
     */
    onPageReady?: (page: Page) => Promise<void>
}

export interface JoinResult {
    bot_id: string
    /**
     * Playwright Page handle for the joined meeting. Exposed so callers
     * can attach further instrumentation (e.g. audioCapture in Milestone C).
     */
    page: Page
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
            // Try the next selector.
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
            // Try the next selector.
        }
    }
    throw new Error(
        'Could not find the "Ask to join" / "Join now" button on Google Meet',
    )
}

export async function joinMeet(params: JoinMeetParams): Promise<JoinResult> {
    if (!isGoogleMeetUrl(params.meeting_url)) {
        throw new Error(
            `joinMeet only supports Google Meet URLs; got: ${params.meeting_url}`,
        )
    }

    const bot_id = randomUUID()

    // Headful Chrome: Xvfb provides the display inside the container.
    // Explicitly pass DISPLAY through Playwright's env option in case
    // chromium.launch doesn't inherit it from the parent process.
    const launchOpts: LaunchOptions = {
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--use-fake-ui-for-media-stream',
            // Critical for audio capture: without this, AudioContext is
            // created in 'suspended' state and stays there forever
            // because there's no real user gesture inside Playwright.
            // Web Audio graph won't push frames through the mixer if
            // the context is suspended.
            '--autoplay-policy=no-user-gesture-required',
        ],
        env: {
            ...process.env,
            DISPLAY: process.env.DISPLAY ?? ':99',
        } as NodeJS.ProcessEnv,
    }
    const browser: Browser = await chromium.launch(launchOpts)

    const context: BrowserContext = await browser.newContext()
    // Grant mic + camera so Meet's pre-join screen doesn't prompt.
    await context.grantPermissions(['camera', 'microphone'], {
        origin: 'https://meet.google.com',
    })

    const page = await context.newPage()

    // CRITICAL: any inject scripts that need to observe Meet's JavaScript
    // (e.g. wrapping RTCPeerConnection for audio capture) must be added
    // here, BEFORE the goto. Once Meet starts running, its WebRTC setup
    // happens early and any wrapper installed later is too late.
    if (params.onPageReady) {
        await params.onPageReady(page)
    }

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

    return { bot_id, page, close }
}
