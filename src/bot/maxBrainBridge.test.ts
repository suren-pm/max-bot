import { AddressInfo } from 'net'

import { WebSocketServer, WebSocket } from 'ws'

import { AudioStream } from './audioStream'
import { MaxBrainBridge } from './maxBrainBridge'

function spinUpFakeBrain(): Promise<{
    wss: WebSocketServer
    port: number
    close: () => Promise<void>
}> {
    return new Promise((resolve) => {
        const wss = new WebSocketServer({ port: 0 })
        wss.on('listening', () => {
            const port = (wss.address() as AddressInfo).port
            resolve({
                wss,
                port,
                close: () =>
                    new Promise<void>((res) => {
                        wss.close(() => res())
                    }),
            })
        })
    })
}

describe('MaxBrainBridge', () => {
    it('connects to ${wsUrl}/${bot_id} on construction', async () => {
        const env = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const inject = {
            pushInt16Buffer: jest.fn(),
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        const connectPromise = new Promise<string>((resolve) => {
            env.wss.on('connection', (_ws, req) => {
                resolve(req.url ?? '')
            })
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env.port}`,
            botId: 'test-bot-id',
            audioStream: stream,
            audioInject: inject as never,
        })

        const url = await connectPromise
        expect(url).toBe('/test-bot-id')

        bridge.stop()
        await env.close()
    })

    it('forwards AudioStream chunks to the WebSocket as binary frames', async () => {
        const env = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const inject = {
            pushInt16Buffer: jest.fn(),
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        const received: Buffer[] = []
        env.wss.on('connection', (ws) => {
            ws.on('message', (m: Buffer) => {
                received.push(m)
            })
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env.port}`,
            botId: 'bot-fwd',
            audioStream: stream,
            audioInject: inject as never,
        })

        // Wait for connection to open
        await new Promise((r) => setTimeout(r, 100))

        // Push some audio through AudioStream
        const input = new Float32Array(160)
        input.fill(0.5)
        stream.pushFloat32(input)

        await new Promise((r) => setTimeout(r, 100))
        expect(received).toHaveLength(1)
        expect(received[0].length).toBe(160 * 2) // 160 samples × 2 bytes Int16

        bridge.stop()
        await env.close()
    })

    it('forwards incoming WebSocket binary frames to AudioInject.pushInt16Buffer', async () => {
        const env = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const pushMock = jest.fn()
        const inject = {
            pushInt16Buffer: pushMock,
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        let serverWs: WebSocket | null = null
        env.wss.on('connection', (ws) => {
            serverWs = ws
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env.port}`,
            botId: 'bot-recv',
            audioStream: stream,
            audioInject: inject as never,
        })

        // Wait for connection to be accepted server-side
        await new Promise((r) => setTimeout(r, 100))
        expect(serverWs).not.toBeNull()

        // Server sends bytes to client
        const payload = Buffer.alloc(4)
        payload.writeInt16LE(100, 0)
        payload.writeInt16LE(200, 2)
        serverWs!.send(payload, { binary: true })

        await new Promise((r) => setTimeout(r, 100))
        expect(pushMock).toHaveBeenCalled()
        const got: Buffer = pushMock.mock.calls[0][0]
        expect(got.length).toBe(4)
        expect(got.readInt16LE(0)).toBe(100)
        expect(got.readInt16LE(2)).toBe(200)

        bridge.stop()
        await env.close()
    })

    it('stop() closes the WebSocket and stops forwarding', async () => {
        const env = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const inject = {
            pushInt16Buffer: jest.fn(),
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        let closeFired = false
        env.wss.on('connection', (ws) => {
            ws.on('close', () => {
                closeFired = true
            })
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env.port}`,
            botId: 'bot-stop',
            audioStream: stream,
            audioInject: inject as never,
        })

        await new Promise((r) => setTimeout(r, 100))
        bridge.stop()
        await new Promise((r) => setTimeout(r, 100))

        expect(closeFired).toBe(true)
        await env.close()
    })
})
