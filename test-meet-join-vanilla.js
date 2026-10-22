// FULL join test — fills the name, clicks "Ask to join", reports where it
// actually lands. Unlike test-meet-local.js (navigation-only diagnostic),
// this exercises the real join path.
//
// PRIVACY FIX vs test-meet-local.js:
//   - Camera permission is NOT granted (mic only), so Chromium cannot open
//     the real FaceTime camera. Max is audio-only by design.
//   - Camera is also explicitly toggled off in the pre-join UI as a belt-and-
//     braces second layer, before anything is sent.
//
// Usage:
//   node test-meet-join.js https://meet.google.com/abc-defg-hij [BotName]

const { chromium } = require('playwright')


const NAME_SELECTORS = [
    'input[type="text"][placeholder*="name" i]',
    'input[aria-label*="name" i]',
    'input[placeholder*="Your name" i]',
]

const JOIN_SELECTORS = [
    'button:has-text("Ask to join")',
    'button:has-text("Join now")',
    'span:has-text("Ask to join")',
    'span:has-text("Join now")',
    'button[aria-label*="Ask to join" i]',
]

async function turnCameraOff(page) {
    // Meet renders a camera toggle on the pre-join screen. If it reports
    // "Turn off camera" the camera is currently ON — click to disable.
    const camSelectors = [
        'button[aria-label*="Turn off camera" i]',
        'div[role="button"][aria-label*="Turn off camera" i]',
    ]
    for (const sel of camSelectors) {
        try {
            const el = await page.$(sel)
            if (el) {
                await el.click({ timeout: 3000 })
                console.log(`  camera: clicked "${sel}" -> OFF`)
                return true
            }
        } catch (e) {
            /* keep trying */
        }
    }
    console.log('  camera: no "Turn off camera" control found (likely already off)')
    return false
}

async function dismissDialogs(page) {
    // Meet shows modal nudges (sign-in prompt, Gemini notice) whose scrim
    // intercepts pointer events, so clicks on the name box silently fail.
    const DISMISS = [
        'button:has-text("Got it")',
        'button:has-text("Dismiss")',
        'button:has-text("No thanks")',
        'button:has-text("Not now")',
        'button:has-text("Continue without")',
        'button[aria-label*="Close" i]',
        'button[aria-label*="Dismiss" i]',
    ]
    let n = 0
    for (let pass = 0; pass < 3; pass++) {
        for (const sel of DISMISS) {
            try {
                const el = await page.$(sel)
                if (!el) continue
                const label = (await el.innerText().catch(() => '')) || sel
                await el.click({ timeout: 2000, force: true })
                console.log('  dismiss: clicked "' + label.trim() + '"')
                n++
                await page.waitForTimeout(400)
            } catch (e) { /* ignore */ }
        }
    }
    if (!n) console.log('  dismiss: no blocking dialogs found')
    return n
}

async function fillName(page, botName) {
    await dismissDialogs(page)
    for (const sel of NAME_SELECTORS) {
        try {
            const el = await page.$(sel)
            if (!el) continue

            // Type like a human, not .fill(). Two reasons:
            //  1) Meet's name box is React-controlled — .fill() can set the DOM
            //     value without firing the events React needs, so it submits EMPTY.
            //  2) Instant fills look robotic; per-key delay is closer to a person.
            await el.focus().catch(async () => {
                await el.click({ timeout: 5000, force: true })
            })
            await page.waitForTimeout(300)
            await el.fill('') // clear any placeholder residue
            await page.keyboard.type(botName, { delay: 120 })
            await page.waitForTimeout(500)

            // VERIFY the value actually landed — do not trust the call.
            const actual = await el.inputValue().catch(() => null)
            console.log(`  name: selector "${sel}"`)
            console.log(`  name: READ-BACK value = ${JSON.stringify(actual)}`)
            if (actual && actual.trim() === botName) {
                console.log('  name: ✅ verified present in the field')
                return true
            }
            console.log('  name: ⚠️  value did NOT stick — retrying via JS + events')

            // Fallback: set through the native setter so React's onChange fires.
            await el.evaluate((node, val) => {
                const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype,
                    'value',
                ).set
                setter.call(node, val)
                node.dispatchEvent(new Event('input', { bubbles: true }))
                node.dispatchEvent(new Event('change', { bubbles: true }))
            }, botName)
            await page.waitForTimeout(500)
            const actual2 = await el.inputValue().catch(() => null)
            console.log(`  name: READ-BACK after JS = ${JSON.stringify(actual2)}`)
            return !!(actual2 && actual2.trim() === botName)
        } catch (e) {
            console.log(`  name: error on "${sel}": ${e.message}`)
        }
    }
    console.log('  name: NO name input found')
    return false
}

async function clickJoin(page) {
    for (const sel of JOIN_SELECTORS) {
        try {
            const el = await page.$(sel)
            if (el) {
                const label = (await el.innerText().catch(() => '')) || sel
                await el.click({ timeout: 5000, force: true })
                console.log(`  join: clicked "${label.trim()}"`)
                return label.trim()
            }
        } catch (e) {
            /* keep trying */
        }
    }
    console.log('  join: NO join button found')
    return null
}

;(async () => {
    const meetUrl = process.argv[2]
    const botName = process.argv[3] || 'Max'
    if (!meetUrl || !meetUrl.includes('meet.google.com')) {
        console.error('Usage: node test-meet-join.js <meet-url> [BotName]')
        process.exit(1)
    }

    // --profile reuses ~/max-bot-profile (created by setup-google-profile.js),
    // so the bot joins as an AUTHENTICATED Google user instead of a guest.
    const useProfile = process.argv.includes('--profile')
    const profileDir = useProfile
        ? process.env.MAX_BOT_PROFILE ||
          require('path').join(require('os').homedir(), 'max-bot-profile')
        : ''
    console.log(
        useProfile
            ? `Launching Chromium with SIGNED-IN profile: ${profileDir}`
            : 'Launching Chromium (anonymous guest, mic only, NO camera)...',
    )
    const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        channel: 'chrome', // REAL Google Chrome (151.x), not bundled Chromium
        viewport: { width: 1280, height: 720 },
        locale: 'en-US',
        // CAMERA DELIBERATELY OMITTED — audio-only bot.
        permissions: ['microphone'],
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
        args: [
            '--autoplay-policy=no-user-gesture-required',
        ],
    })


    const page = await context.newPage()

    console.log('Warm-up: google.com ...')
    try {
        await page.goto('https://www.google.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
        })
        await page.waitForTimeout(2500)
    } catch (e) {
        console.warn('  warm-up failed (continuing):', e.message)
    }

    console.log(`Navigating to ${meetUrl} ...`)
    await page.goto(meetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(5000)

    // ---- STAGE 1: did we even reach the pre-join screen? ----
    const preUrl = page.url()
    console.log('\n--- STAGE 1: reached pre-join? ---')
    console.log('  URL:  ', preUrl)
    console.log('  Title:', await page.title())
    if (preUrl.includes('workspace.google.com')) {
        console.log('\n❌ BLOCKED at page level — redirected to workspace.google.com')
        await context.close()
        process.exit(1)
    }

    // ---- STAGE 2: privacy — camera off ----
    console.log('\n--- STAGE 2: camera off ---')
    await turnCameraOff(page)
    await page.waitForTimeout(1000)

    // ---- STAGE 3: fill name ----
    console.log('\n--- STAGE 3: fill name ---')
    const named = await fillName(page, botName)

    // ---- STAGE 3b: visual proof of the pre-join state BEFORE clicking ----
    await page
        .screenshot({ path: 'prejoin-before-click.png', fullPage: false })
        .catch(() => {})
    console.log('  screenshot: prejoin-before-click.png (name box visible here)')

    // ---- STAGE 4: click join ----
    console.log('\n--- STAGE 4: click join ---')
    const clicked = await clickJoin(page)

    // ---- STAGE 5: where did we actually land? ----
    // Poll for up to 45s so a human host has time to click "Admit".
    console.log('\n--- STAGE 5: post-click state (polling up to 45s) ---')
    let lastSnap = ''
    for (let i = 0; i < 9; i++) {
        await page.waitForTimeout(5000)
        const snap = await page
            .evaluate(() => (document.body.innerText || '').slice(0, 160))
            .catch(() => '')
        const flat = snap.replace(/\n/g, ' | ')
        if (flat !== lastSnap) {
            console.log(`  [${(i + 1) * 5}s] ${flat}`)
            lastSnap = flat
        }
        const l = snap.toLowerCase()
        if (l.includes("can't join") || l.includes('leave call')) break
    }

    const finalUrl = page.url()
    const body = await page.evaluate(() =>
        (document.body.innerText || '').slice(0, 600),
    )
    await page
        .screenshot({ path: 'join-test-result.png', fullPage: false })
        .catch(() => {})

    console.log('  URL:  ', finalUrl)
    console.log('  Body: ', body.replace(/\n/g, ' | '))
    console.log('  Screenshot: join-test-result.png')

    const lower = body.toLowerCase()
    console.log('\n========== VERDICT ==========')
    if (lower.includes("can't join") || lower.includes('cannot join')) {
        console.log('❌ DENIED — Meet refused the join')
    } else if (
        lower.includes('asking to be let in') ||
        lower.includes('waiting for someone') ||
        lower.includes('someone will let you in')
    ) {
        console.log('✅ IN WAITING ROOM — host admission pending')
    } else if (
        lower.includes('leave call') ||
        lower.includes('you are the only one') ||
        lower.includes('meeting details')
    ) {
        console.log('✅✅ ACTUALLY IN THE MEETING')
    } else if (!named || !clicked) {
        console.log('⚠️  INCONCLUSIVE — name or join control not found')
    } else {
        console.log('⚠️  UNKNOWN state — inspect body text and screenshot above')
    }
    console.log('=============================\n')

    await context.close()
    console.log('Browser closed.')
})()
