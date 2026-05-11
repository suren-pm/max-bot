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
    const launchOpts: LaunchOptions = {
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--use-fake-ui-for-media-stream',
        ],
    }
    const browser: Browser = await chromium.launch(launchOpts)

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
