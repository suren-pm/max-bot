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
    LaunchOptions,
    Page,
} from 'playwright'
// Use playwright-extra so we can plug in the stealth plugin. The plugin
// overrides ~20 detection signals (WebGL renderer, AudioContext, Sec-CH-UA
// hints, hardwareConcurrency, deviceMemory, plugins, languages,
// navigator.permissions, navigator.webdriver, etc.) in one shot.
// playwright-extra's `chromium` is a drop-in replacement for playwright's.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { chromium } = require('playwright-extra') as {
    chromium: typeof import('playwright').chromium
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
;(chromium as unknown as { use: (plugin: unknown) => void }).use(
    StealthPlugin(),
)

// node 16+ has crypto.randomUUID(), but upstream's @types/node is pinned
// at 14.x, so we cast around the missing type declaration.
const randomUUID = (crypto as unknown as { randomUUID: () => string })
    .randomUUID

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
    /**
     * Invoked when Playwright's page emits `close` or `crash`. The
     * page can no longer be used after this fires. Callers should
     * tear down the session.
     */
    onPageDeath?: (event: PageDeath) => void
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
    // Capture page state to know whether stealth bypassed the redirect
    // (page should be meet.google.com/<room>) or whether anti-bot is
    // still kicking in (page would be workspace.google.com).
    let currentUrl = 'unknown'
    let currentTitle = 'unknown'
    let allInputs: string[] = []
    let visibleButtons: string[] = []
    let bodySnippet = ''
    try {
        currentUrl = page.url()
        currentTitle = await page.title()
        allInputs = await page.$$eval('input', (els) =>
            els.map((el) => {
                const e = el as HTMLInputElement
                return JSON.stringify({
                    type: e.type,
                    placeholder: e.placeholder,
                    aria_label: e.getAttribute('aria-label'),
                })
            }),
        )
        visibleButtons = await page.$$eval('button, [role=button]', (els) =>
            els
                .map((el) =>
                    (
                        (el as HTMLElement).innerText ||
                        el.getAttribute('aria-label') ||
                        ''
                    ).trim(),
                )
                .filter((t) => t.length > 0 && t.length < 60),
        )
        bodySnippet = await page.evaluate(() =>
            (document.body.innerText || '').slice(0, 500),
        )
    } catch {
        /* ignore */
    }
    throw new Error(
        `Could not find the bot-name input on Google Meet. ` +
            `URL=${currentUrl} title="${currentTitle}" ` +
            `inputs=${JSON.stringify(allInputs)} ` +
            `buttons=${JSON.stringify(visibleButtons.slice(0, 20))} ` +
            `body="${bodySnippet.replace(/\n/g, ' | ')}"`,
    )
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
    //
    // 2026-06-08: Diagnostic proved Google redirects Playwright-launched
    // Chromium to workspace.google.com marketing page; incognito Chrome
    // on the same URL reaches the pre-join screen. The 3 stealth-targeted
    // additions below are the minimum required to bypass the redirect:
    //   1) ignoreDefaultArgs strips --enable-automation
    //   2) realistic macOS Chrome user-agent in newContext
    //   3) addInitScript overrides navigator.webdriver to undefined
    const launchOpts: LaunchOptions = {
        headless: false,
        // Strip Playwright's default --enable-automation flag, which is
        // a known bot tell.
        ignoreDefaultArgs: ['--enable-automation'],
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

    const context: BrowserContext = await browser.newContext({
        // Real macOS Chrome user-agent so Google's edge doesn't redirect
        // us as a likely-bot user-agent. Matches the version pattern of
        // an up-to-date Chrome on macOS.
        userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/131.0.0.0 Safari/537.36',
        // Force Accept-Language to en-US so it stays consistent with the
        // UA. Without this, Playwright inherits the container's system
        // locale (Dutch in our Railway egress region) which contradicts
        // the en-US UA — a fingerprint mismatch tell.
        locale: 'en-US',
    })
    // Grant mic + camera so Meet's pre-join screen doesn't prompt.
    await context.grantPermissions(['camera', 'microphone'], {
        origin: 'https://meet.google.com',
    })

    // Override navigator.webdriver to undefined BEFORE any site JS runs.
    // This is the JS-level bot tell that Meet checks once the page loads.
    // Also override navigator.platform to match the macOS UA we sent —
    // otherwise Linux container leaks through and Meet detects the
    // platform vs UA mismatch, redirecting us to the marketing page
    // a few seconds AFTER initial page load.
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        })
        Object.defineProperty(navigator, 'platform', {
            get: () => 'MacIntel',
        })
    })

    const page = await context.newPage()

    if (params.onPageDeath) {
        wirePageDeath(page, params.onPageDeath)
    }

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
