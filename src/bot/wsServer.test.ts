import { createServer as createHttpServer, Server as HttpServer } from 'http'
import { AddressInfo } from 'net'

import WebSocket from 'ws'

import { AudioStream } from './audioStream'
import { _clearAllSessions, registerSession } from './sessions'
import { attachWebSocketServer } from './wsServer'

function spinUp(): Promise<{
    server: HttpServer
    port: number
    close: () => Promise<void>
}> {
    return new Promise((resolve) => {
        const http: HttpServer = createHttpServer()
        attachWebSocketServer(http)
        http.listen(0, () => {
            const port = (http.address() as AddressInfo).port
            resolve({
                server: http,
                port,
                close: () =>
                    new Promise<void>((res) => {
                        http.close(() => res())
                    }),
            })
        })
    })
}

describe('attachWebSocketServer', () => {
    afterEach(() => {
        _clearAllSessions()
    })

    it('rejects connection to /ws/<unknown_bot_id> with close code 1008', async () => {
        const { close } = await spinUp().then(async (env) => {
            const ws = new WebSocket(`ws://localhost:${env.port}/ws/nope`)
            const code: number = await new Promise((res, rej) => {
                ws.on('close', (c) => res(c))
                ws.on('error', () => {
                    /* swallow — close handler will fire */
                })
                setTimeout(() => rej(new Error('timeout')), 3000)
            })
            expect(code).toBe(1008)
            return env
        })
        await close()
    })

    it('accepts connection to /ws/<bot_id> when session exists', async () => {
        const env = await spinUp()
        const stream = new AudioStream({
            srcSampleRate: 48000,
            dstSampleRate: 16000,
        })
        registerSession({
            bot_id: 'abc',
            meeting_url: 'https://meet.google.com/abc',
            bot_name: 'Max',
            startedAt: new Date(),
            audioStream: stream,
            audioInject: {} as never,
            page: {} as never,
            close: async () => {},
        })

        const ws = new WebSocket(`ws://localhost:${env.port}/ws/abc`)
        await new Promise<void>((res, rej) => {
            ws.on('open', () => res())
            ws.on('close', (c) => rej(new Error('closed unexpectedly ' + c)))
            ws.on('error', (e) => rej(e))
            setTimeout(() => rej(new Error('timeout')), 3000)
        })
        ws.close()
        await env.close()
    })

    it('forwards Buffer chunks from the AudioStream to the WS client', async () => {
        const env = await spinUp()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        registerSession({
            bot_id: 'forward',
            meeting_url: 'https://meet.google.com/xyz',
            bot_name: 'Max',
            startedAt: new Date(),
            audioStream: stream,
            audioInject: {} as never,
            page: {} as never,
            close: async () => {},
        })

        const ws = new WebSocket(`ws://localhost:${env.port}/ws/forward`)
        await new Promise<void>((res, rej) => {
            ws.on('open', () => res())
            ws.on('error', (e) => rej(e))
            setTimeout(() => rej(new Error('open timeout')), 3000)
        })

        const received: Buffer[] = []
        ws.on('message', (m: WebSocket.RawData) => {
            received.push(m as Buffer)
        })

        const input = new Float32Array(160)
        input.fill(0.5)
        stream.pushFloat32(input)

        // Give the WS a tick to flush.
        await new Promise((r) => setTimeout(r, 100))
        expect(received).toHaveLength(1)
        expect(received[0].length).toBe(320) // 160 samples * 2 bytes Int16

        ws.close()
        await env.close()
    })
})

describe('attachWebSocketServer — /ws_in/:bot_id (injection)', () => {
    afterEach(() => {
        _clearAllSessions()
    })

    it('rejects unknown bot_id with close code 1008', async () => {
        const env = await spinUp()
        const ws = new WebSocket(`ws://localhost:${env.port}/ws_in/nope`)
        const code: number = await new Promise((res, rej) => {
            ws.on('close', (c) => res(c))
            ws.on('error', () => {
                /* swallow */
            })
            setTimeout(() => rej(new Error('timeout')), 3000)
        })
        expect(code).toBe(1008)
        await env.close()
    })

    it('forwards binary frames to session.audioInject.pushInt16Buffer', async () => {
        const pushMock = jest.fn()
        const inj = {
            pushInt16Buffer: pushMock,
            stop: jest.fn(),
        }
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        registerSession({
            bot_id: 'inj1',
            meeting_url: 'https://meet.google.com/abc',
            bot_name: 'Max',
            startedAt: new Date(),
            audioStream: stream,
            audioInject: inj as never,
            page: {} as never,
            close: async () => {},
        })

        const env = await spinUp()
        const ws = new WebSocket(`ws://localhost:${env.port}/ws_in/inj1`)
        await new Promise<void>((res, rej) => {
            ws.on('open', () => res())
            ws.on('error', (e) => rej(e))
            setTimeout(() => rej(new Error('open timeout')), 3000)
        })

        const buf = Buffer.alloc(4)
        buf.writeInt16LE(100, 0)
        buf.writeInt16LE(200, 2)
        ws.send(buf, { binary: true })

        // Allow the server side to receive the frame.
        await new Promise((r) => setTimeout(r, 100))
        expect(pushMock).toHaveBeenCalled()
        const passed: Buffer = pushMock.mock.calls[0][0]
        expect(passed.length).toBe(4)
        expect(passed.readInt16LE(0)).toBe(100)
        expect(passed.readInt16LE(2)).toBe(200)

        ws.close()
        await env.close()
    })
})
