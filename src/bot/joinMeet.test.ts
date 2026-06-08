// Mock playwright-extra (which our joinMeet.ts uses via require) so unit
// tests don't try to launch real Chromium.
jest.mock('playwright-extra', () => {
    const fillMock = jest.fn(async () => {})
    const clickMock = jest.fn(async () => {})
    const waitForMock = jest.fn(async () => {})
    const gotoMock = jest.fn(async () => ({ status: () => 200 }))
    const closePageMock = jest.fn(async () => {})
    const locatorFirstMock = jest.fn(() => ({
        waitFor: waitForMock,
        fill: fillMock,
        click: clickMock,
    }))
    const locatorMock = jest.fn(() => ({ first: locatorFirstMock }))
    const evalMock = jest.fn(async () => '')
    const $$evalMock = jest.fn(async () => [])
    const evaluateMock = jest.fn(async () => '')
    const titleMock = jest.fn(async () => 'Meet')
    const urlMock = jest.fn(() => 'https://meet.google.com/abc-defg-hij')
    const setBypassCSPMock = jest.fn(async () => {})
    const newPageMock = jest.fn(async () => ({
        goto: gotoMock,
        locator: locatorMock,
        close: closePageMock,
        $$eval: $$evalMock,
        evaluate: evaluateMock,
        title: titleMock,
        url: urlMock,
        setBypassCSP: setBypassCSPMock,
    }))
    const grantPermissionsMock = jest.fn(async () => {})
    const addInitScriptMock = jest.fn(async () => {})
    const closeContextMock = jest.fn(async () => {})
    const launchPersistentContextMock = jest.fn(async () => ({
        newPage: newPageMock,
        grantPermissions: grantPermissionsMock,
        addInitScript: addInitScriptMock,
        close: closeContextMock,
    }))
    const useMock = jest.fn(() => {})
    return {
        chromium: {
            launchPersistentContext: launchPersistentContextMock,
            use: useMock,
        },
        __mocks__: {
            launchPersistentContextMock,
            newPageMock,
            gotoMock,
            locatorMock,
            locatorFirstMock,
            waitForMock,
            fillMock,
            clickMock,
            closePageMock,
            closeContextMock,
            grantPermissionsMock,
            useMock,
        },
    }
})

// Stealth plugin is required separately; provide a no-op stub.
jest.mock('puppeteer-extra-plugin-stealth', () => {
    return jest.fn(() => ({
        enabledEvasions: {
            delete: jest.fn(),
        },
    }))
})

// playwright (the raw types) is still imported for BrowserContext / Page
// type definitions only; mock it as empty objects so import doesn't fail.
jest.mock('playwright', () => ({}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const playwrightExtra = require('playwright-extra')
import { joinMeet, JoinResult } from './joinMeet'

const mocks = (
    playwrightExtra as unknown as { __mocks__: Record<string, jest.Mock> }
).__mocks__

describe('joinMeet', () => {
    beforeEach(() => {
        Object.values(mocks).forEach((m) => m.mockClear())
    })

    it('launches Chromium, navigates to the meeting URL, types the bot name, clicks join, and returns bot_id', async () => {
        const result: JoinResult = await joinMeet({
            meeting_url: 'https://meet.google.com/abc-defg-hij',
            bot_name: 'Max',
        })

        expect(result.bot_id).toMatch(/^[0-9a-f-]{36}$/)
        expect(result.page).toBeDefined()
        expect(mocks.launchPersistentContextMock).toHaveBeenCalled()
        expect(mocks.gotoMock).toHaveBeenCalledWith(
            'https://meet.google.com/abc-defg-hij',
            expect.objectContaining({ waitUntil: expect.any(String) }),
        )
        expect(mocks.fillMock).toHaveBeenCalledWith('Max')
        expect(mocks.clickMock).toHaveBeenCalled()
    })

    it('returns a close() handle that tears down the browser', async () => {
        const result = await joinMeet({
            meeting_url: 'https://meet.google.com/abc-defg-hij',
            bot_name: 'Max',
        })
        await result.close()
        expect(mocks.closePageMock).toHaveBeenCalled()
        expect(mocks.closeContextMock).toHaveBeenCalled()
    })

    it('throws if meeting_url is not a Google Meet URL', async () => {
        await expect(
            joinMeet({
                meeting_url: 'https://teams.microsoft.com/foo',
                bot_name: 'Max',
            }),
        ).rejects.toThrow(/google meet/i)
    })

    it('throws if meeting_url is malformed', async () => {
        await expect(
            joinMeet({
                meeting_url: 'not a url at all',
                bot_name: 'Max',
            }),
        ).rejects.toThrow(/google meet/i)
    })
})

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

    it('fires onPageDeath at most once even if both events fire', async () => {
        const { wirePageDeath } = await import('./joinMeet')
        const deathHandler = jest.fn()
        const fakePage = {
            isClosed: jest.fn(() => false),
            on: jest.fn((event: string, cb: () => void) => {
                if (event === 'close' || event === 'crash') {
                    setTimeout(cb, 10)
                }
            }),
        } as unknown as import('playwright').Page

        wirePageDeath(fakePage, deathHandler)
        await new Promise((r) => setTimeout(r, 80))
        expect(deathHandler).toHaveBeenCalledTimes(1)
    })
})
