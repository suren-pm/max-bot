// One-time: open a real Chromium against a DEDICATED profile folder so Suren
// can sign a Google account in BY HAND. Claude never sees or types credentials.
//
// After sign-in, close the window. The session cookies persist in the profile
// dir, and test-meet-join.js --profile can then reuse them so the bot joins
// Meet as an AUTHENTICATED user instead of an anonymous guest.
//
// ⚠️  Use a DEDICATED / throwaway Google account — never your admin account.
//     Automating a Google account carries a real (if unquantified) suspension
//     risk. Recall.ai's own docs warn against using admin accounts for bots.
//
// Usage:
//   node setup-google-profile.js
//   (sign in, then just close the browser window)

const path = require('path')
const os = require('os')
const { chromium } = require('playwright-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')

const stealth = StealthPlugin()
// Keep evasion set IDENTICAL to joinMeet.ts so the fingerprint that signs in
// is the same one that later joins. A mismatch here is itself a risk signal.
stealth.enabledEvasions.delete('iframe.contentWindow')
stealth.enabledEvasions.delete('media.codecs')
chromium.use(stealth)

const PROFILE_DIR =
    process.env.MAX_BOT_PROFILE || path.join(os.homedir(), 'max-bot-profile')

;(async () => {
    console.log('Profile dir:', PROFILE_DIR)
    console.log('Opening Chromium — sign in by hand, then CLOSE the window.\n')

    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/131.0.0.0 Safari/537.36',
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
        ],
    })

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
    })

    const page = context.pages()[0] || (await context.newPage())
    await page.goto('https://accounts.google.com/', {
        waitUntil: 'domcontentloaded',
    })

    console.log('Waiting for you to finish and close the window...')
    await context.waitForEvent('close', { timeout: 0 })
    console.log('\nProfile saved to:', PROFILE_DIR)
    console.log('Now run:  node test-meet-join.js <meet-url> Max --profile')
})()
