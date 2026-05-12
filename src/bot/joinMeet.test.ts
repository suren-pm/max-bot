// Mock playwright so the unit tests don't try to launch real Chromium.
jest.mock('playwright', () => {
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
    const newPageMock = jest.fn(async () => ({
        goto: gotoMock,
        locator: locatorMock,
        close: closePageMock,
    }))
    const grantPermissionsMock = jest.fn(async () => {})
    const closeContextMock = jest.fn(async () => {})
    const newContextMock = jest.fn(async () => ({
        newPage: newPageMock,
        grantPermissions: grantPermissionsMock,
        close: closeContextMock,
    }))
    const closeBrowserMock = jest.fn(async () => {})
    const launchMock = jest.fn(async () => ({
        newContext: newContextMock,
        close: closeBrowserMock,
    }))
    return {
        chromium: { launch: launchMock },
        __mocks__: {
            launchMock,
            newContextMock,
            newPageMock,
            gotoMock,
            locatorMock,
            locatorFirstMock,
            waitForMock,
            fillMock,
            clickMock,
            closePageMock,
            closeContextMock,
            closeBrowserMock,
            grantPermissionsMock,
        },
    }
})

import * as playwright from 'playwright'

import { joinMeet, JoinResult } from './joinMeet'

const mocks = (playwright as unknown as { __mocks__: Record<string, jest.Mock> })
    .__mocks__

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
        expect(mocks.launchMock).toHaveBeenCalled()
        expect(mocks.gotoMock).toHaveBeenCalledWith(
            'https://meet.google.com/abc-defg-hij',
            expect.objectContaining({ waitUntil: expect.any(String) }),
        )
        // Bot name typed.
        expect(mocks.fillMock).toHaveBeenCalledWith('Max')
        // Join CTA clicked.
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
        expect(mocks.closeBrowserMock).toHaveBeenCalled()
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
