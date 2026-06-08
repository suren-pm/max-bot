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
    BrowserContext,
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
// Known-fix from puppeteer-extra discussion #907 / issue #334: Google Meet
// specifically detects two stealth evasions and serves the "You can't join
// this video call" error page when they're enabled. Disabling these two —
// while keeping all the other ~18 evasions active — lets a guest reach
// the real pre-join screen.
const stealthInstance = StealthPlugin() as {
    enabledEvasions: { delete: (name: string) => boolean }
}
stealthInstance.enabledEvasions.delete('iframe.contentWindow')
stealthInstance.enabledEvasions.delete('media.codecs')
;(chromium as unknown as { use: (plugin: unknown) => void }).use(
    stealthInstance,
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

    // Mirror the upstream meet-teams-bot/src/browser/browser.ts production
    // launch config — that codebase joins Google Meet successfully in
    // Docker today. Critical bits we lacked:
    //   1) launchPersistentContext (not launch + newContext) — persistent
    //      user-data-dir = state accumulates = looks like a real user
    //   2) bypassCSP at the context level
    //   3) full WebRTC + audio + certificate launch args
    //   4) permissions granted at launch (not after)
    //   5) ignoreHTTPSErrors + acceptDownloads
    const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'
    const context = (await (chromium as unknown as {
        launchPersistentContext: (
            userDataDir: string,
            opts: Record<string, unknown>,
        ) => Promise<BrowserContext>
    }).launchPersistentContext('', {
        headless: false,
        viewport: { width: 1280, height: 720 },
        executablePath: chromePath,
        locale: 'en-US',
        userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/131.0.0.0 Safari/537.36',
        permissions: ['microphone', 'camera'],
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
        bypassCSP: true,
        timeout: 120000,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--window-size=1280,860',
            '--window-position=0,0',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--lang=en-US',
            '--accept-lang=en-US,en',
            // PulseAudio / audio
            '--use-pulseaudio',
            '--enable-audio-service-sandbox=false',
            '--audio-buffer-size=2048',
            '--disable-features=AudioServiceSandbox',
            '--autoplay-policy=no-user-gesture-required',
            // WebRTC optimizations — Meet checks WebRTC capabilities heavily
            '--disable-rtc-smoothness-algorithm',
            '--disable-webrtc-hw-decoding',
            '--disable-webrtc-hw-encoding',
            '--enable-webrtc-capture-audio',
            '--force-webrtc-ip-handling-policy=default',
            // Anti-bot tells
            '--disable-blink-features=AutomationControlled',
            '--disable-background-timer-throttling',
            '--enable-features=SharedArrayBuffer',
            // Certs
            '--ignore-certificate-errors',
            '--allow-insecure-localhost',
            '--disable-blink-features=TrustedDOMTypes',
            '--disable-features=TrustedScriptTypes',
            '--disable-features=TrustedHTML',
            // Resource mgmt
            '--memory-pressure-off',
            '--disable-background-networking',
            '--disable-features=TranslateUI',
            '--disable-features=AutofillServerCommunication',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--disable-features=MediaRouter',
        ],
        env: {
            ...process.env,
            DISPLAY: process.env.DISPLAY ?? ':99',
        } as NodeJS.ProcessEnv,
    })) as BrowserContext

    // Override navigator.webdriver + platform BEFORE any site JS runs.
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

    // Browser warm-up: visit google.com first to accumulate "real user"
    // cookies (NID, etc.) BEFORE hitting meet.google.com. The memory file
    // project_max_bot_milestone_f_shipped notes that the May 25 working
    // session had "lucky cookie state" / "real user signals" that fresh
    // containers lack. Real humans don't launch a browser and instantly
    // type meet.google.com/<room> — they've been on Google all day.
    // This recreates that signal without OAuth or IP migration.
    try {
        await page.goto('https://www.google.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
        })
        await page.waitForTimeout(2500)
        await page.mouse.move(400, 300)
        await page.waitForTimeout(300)
        await page.mouse.move(620, 420)
        await page.evaluate(() => {
            window.scrollBy({ top: 200, behavior: 'smooth' })
        })
        await page.waitForTimeout(1500)
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
            '[joinMeet] warm-up navigation failed (continuing):',
            err instanceof Error ? err.message : String(err),
        )
    }

    // domcontentloaded (not 'networkidle') because Meet's WebRTC keeps
    // the network busy indefinitely — networkidle never fires, and the
    // 30s timeout makes fillBotName run too late, by which time Meet has
    // already kicked us to the "you can't join" error page.
    await page.goto(params.meeting_url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    })

    // Best-effort: log + continue if name input or join CTA aren't found.
    // We keep the session alive so /diag/page can inspect what Meet
    // actually displayed.
    try {
        await fillBotName(page, params.bot_name)
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
            '[joinMeet] fillBotName best-effort failed:',
            err instanceof Error ? err.message : String(err),
        )
    }
    try {
        await clickJoinCta(page)
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
            '[joinMeet] clickJoinCta best-effort failed:',
            err instanceof Error ? err.message : String(err),
        )
    }

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
            // launchPersistentContext returns a BrowserContext whose
            // close() also tears down the underlying browser.
            await context.close()
        } catch {
            /* ignore */
        }
    }

    return { bot_id, page, close }
}
