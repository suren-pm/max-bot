import request from 'supertest'

import { createServer } from './app'
import * as joinMeetModule from './bot/joinMeet'
import { _clearAllSessions } from './bot/sessions'

describe('max-bot HTTP server', () => {
    afterEach(() => {
        jest.restoreAllMocks()
        _clearAllSessions()
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
})
