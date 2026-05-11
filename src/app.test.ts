import request from 'supertest'

import { createServer } from './app'

describe('max-bot HTTP server', () => {
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
})
