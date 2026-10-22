// Standalone test: run from your Mac to see if the same stealth+launch
// config that fails on Railway can join Meet from a residential IP.
//
// Usage:
//   node test-meet-local.js https://meet.google.com/YOUR-ROOM-CODE
//
// Watches Chromium open on your screen so you can visually see where it
// lands. Prints URL + title + first 300 chars of page body after 5s.
// Keeps the window open 60s so you can inspect manually.

const { chromium } = require('playwright-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')

const stealth = StealthPlugin()
// Same two evasions Google Meet specifically detects — disabled per
// puppeteer-extra discussion #907.
stealth.enabledEvasions.delete('iframe.contentWindow')
stealth.enabledEvasions.delete('media.codecs')
chromium.use(stealth)

;(async () => {
    const meetUrl = process.argv[2]
    if (!meetUrl || !meetUrl.includes('meet.google.com')) {
        console.error(
            'Usage: node test-meet-local.js https://meet.google.com/abc-defg-hij',
        )
        process.exit(1)
    }

    console.log('Launching Chromium with stealth...')
    const context = await chromium.launchPersistentContext('', {
        headless: false,
        viewport: { width: 1280, height: 720 },
        locale: 'en-US',
        userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/131.0.0.0 Safari/537.36',
        permissions: ['microphone', 'camera'],
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
        bypassCSP: true,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
        ],
    })

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        })
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
    })

    const page = await context.newPage()

    console.log('Warm-up: visiting google.com first...')
    try {
        await page.goto('https://www.google.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
        })
        await page.waitForTimeout(3000)
    } catch (e) {
        console.warn('Warm-up failed (continuing):', e.message)
    }

    console.log(`Navigating to ${meetUrl} ...`)
    await page.goto(meetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    })

    await page.waitForTimeout(5000)
    const url = page.url()
    const title = await page.title()
    const body = await page.evaluate(() =>
        (document.body.innerText || '').slice(0, 300),
    )

    console.log('\n========== RESULT AFTER 5s ==========')
    console.log('URL:   ', url)
    console.log('Title: ', title)
    console.log('Body:  ', body.replace(/\n/g, ' | '))
    console.log('======================================\n')

    if (url.includes('workspace.google.com')) {
        console.log(
            '❌ REDIRECTED to workspace marketing page — Meet detected bot.',
        )
    } else if (url.includes('meet.google.com')) {
        console.log(
            '✅ Stayed on meet.google.com — try filling name and joining manually if input is visible.',
        )
    }

    console.log(
        '\nBrowser stays open for 60s. Observe what Meet shows. Ctrl+C to exit.',
    )
    await page.waitForTimeout(60000)
    await context.close()
})()
