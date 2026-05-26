// Mock child_process.spawn so the AudioInject construction inside /join
// doesn't actually launch ffmpeg (which would fail in CI).
jest.mock('child_process', () => ({
    spawn: jest.fn(() => ({
        stdin: { write: jest.fn(), end: jest.fn(), destroyed: false },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
        pid: 99999,
        killed: false,
    })),
    execSync: jest.requireActual('child_process').execSync,
}))

// Mock MaxBrainBridge so /join's outbound WS attempt doesn't try to
// connect to max-brain during unit tests.
jest.mock('./bot/maxBrainBridge', () => {
    return {
        MaxBrainBridge: jest.fn().mockImplementation(() => ({
            stop: jest.fn(),
            isConnected: jest.fn(() => false),
            disconnectedSince: null,
            heartbeatReconnects: 0,
            bytesReceivedFromBrain: 0,
            messagesReceivedFromBrain: 0,
            bytesSentToBrain: 0,
            chunksSentToBrain: 0,
            lastOpenAt: null,
            lastCloseAt: null,
            lastCloseCode: null,
            lastMessageAt: null,
            lastConnectError: null,
        })),
    }
})

import request from 'supertest'

import { createServer } from './app'
import * as joinMeetModule from './bot/joinMeet'
import { _clearAllSessions } from './bot/sessions'
import { _clearPostmortems } from './bot/postmortem'

describe('max-bot HTTP server', () => {
    afterEach(() => {
        jest.restoreAllMocks()
        _clearAllSessions()
        _clearPostmortems()
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
                page: {} as never,
                close: fakeClose,
            })

            const app = createServer()
            const res = await request(app).post('/join').send({
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
                page: {} as never,
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

        it('passes onPageDeath callback through to joinMeet', async () => {
            const joinSpy = jest.spyOn(joinMeetModule, 'joinMeet')
                .mockResolvedValue({
                    bot_id: 'pd-bot',
                    page: {} as never,
                    close: jest.fn(async () => {}),
                })
            const app = createServer()
            await request(app).post('/join').send({
                meeting_url: 'https://meet.google.com/abc-defg-hij',
                bot_name: 'Max',
            })
            const callArg = joinSpy.mock.calls[0][0]
            expect(typeof callArg.onPageDeath).toBe('function')
        })
    })

    describe('POST /leave/:bot_id', () => {
        it('returns 200 and calls close() on the active session', async () => {
            const closeMock = jest.fn(async () => {})
            jest.spyOn(joinMeetModule, 'joinMeet').mockResolvedValue({
                bot_id: '33333333-3333-3333-3333-333333333333',
                page: {} as never,
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

    describe('POST /leave/:bot_id timeout handling', () => {
        it('returns 200 with forced=true if session.close() hangs', async () => {
            const hangingClose = jest.fn(() => new Promise<void>(() => {
                // Never resolves — simulates hung Playwright cleanup
            }))
            jest.spyOn(joinMeetModule, 'joinMeet').mockResolvedValue({
                bot_id: 'hang-bot',
                page: {} as never,
                close: hangingClose,
            })

            const app = createServer()
            const joinRes = await request(app).post('/join').send({
                meeting_url: 'https://meet.google.com/abc-defg-hij',
                bot_name: 'Max',
            })
            expect(joinRes.status).toBe(200)
            const bot_id = joinRes.body.bot_id

            // /leave should return within ~16 seconds even though close hangs
            const start = Date.now()
            const leaveRes = await request(app).post(`/leave/${bot_id}`)
            const elapsed = Date.now() - start

            expect(leaveRes.status).toBe(200)
            expect(leaveRes.body.forced).toBe(true)
            expect(elapsed).toBeLessThan(17000)
        }, 20000)

        it('returns 200 with forced=false on clean close', async () => {
            const cleanClose = jest.fn(async () => {})
            jest.spyOn(joinMeetModule, 'joinMeet').mockResolvedValue({
                bot_id: 'clean-bot',
                page: {} as never,
                close: cleanClose,
            })

            const app = createServer()
            const joinRes = await request(app).post('/join').send({
                meeting_url: 'https://meet.google.com/abc-defg-hij',
                bot_name: 'Max',
            })
            const bot_id = joinRes.body.bot_id

            const leaveRes = await request(app).post(`/leave/${bot_id}`)
            expect(leaveRes.status).toBe(200)
            expect(leaveRes.body.forced).toBe(false)
        })
    })

    describe('GET /diag/postmortem', () => {
        it('returns empty when nothing has died', async () => {
            const app = createServer()
            const res = await request(app).get('/diag/postmortem')
            expect(res.status).toBe(200)
            expect(res.body.latest).toBeNull()
            expect(Array.isArray(res.body.all)).toBe(true)
        })
    })
})