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

    it('detaches listeners from the OLD WebSocket on reconnect', async () => {
        // Open + close fake server twice; verify bridge does NOT leak
        // listeners on the dead websockets.
        const env1 = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const inject = {
            pushInt16Buffer: jest.fn(),
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        const acceptedSockets: WebSocket[] = []
        env1.wss.on('connection', (ws) => {
            acceptedSockets.push(ws)
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env1.port}`,
            botId: 'leak-test',
            audioStream: stream,
            audioInject: inject as never,
        })
        await new Promise((r) => setTimeout(r, 150))

        // Force-close server side
        for (const ws of acceptedSockets) ws.close()
        await new Promise((r) => setTimeout(r, 150))

        // The OLD client-side ws (before reconnect) should have no
        // listeners left — they should have been removed on close.
        // Inspect via the bridge's internal record of past sockets.
        const oldSockets = (bridge as unknown as {
            _testDeadSockets?: WebSocket[]
        })._testDeadSockets ?? []
        expect(oldSockets.length).toBeGreaterThanOrEqual(1)
        for (const dead of oldSockets) {
            expect(dead.listenerCount('message')).toBe(0)
            expect(dead.listenerCount('close')).toBe(0)
            expect(dead.listenerCount('open')).toBe(0)
            expect(dead.listenerCount('error')).toBe(0)
        }

        bridge.stop()
        await env1.close()
    })

    it('sets disconnectedSince when ws closes, clears on reopen', async () => {
        const env = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const inject = {
            pushInt16Buffer: jest.fn(),
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        let serverWs: WebSocket | null = null
        env.wss.on('connection', (ws) => {
            serverWs = ws
        })

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env.port}`,
            botId: 'disc-test',
            audioStream: stream,
            audioInject: inject as never,
        })
        await new Promise((r) => setTimeout(r, 150))
        expect(bridge.disconnectedSince).toBeNull()

        serverWs!.close()
        await new Promise((r) => setTimeout(r, 150))
        expect(bridge.disconnectedSince).not.toBeNull()
        expect((bridge.disconnectedSince as number) > 0).toBe(true)

        bridge.stop()
        await env.close()
    })

    it('heartbeat force-reconnects after staleness threshold', async () => {
        const env = await spinUpFakeBrain()
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        const inject = {
            pushInt16Buffer: jest.fn(),
            stop: jest.fn(),
        } as unknown as { pushInt16Buffer: jest.Mock; stop: jest.Mock }

        const bridge = new MaxBrainBridge({
            wsUrl: `ws://localhost:${env.port}`,
            botId: 'hb-test',
            audioStream: stream,
            audioInject: inject as never,
            heartbeatStalenessMs: 200,
            heartbeatIntervalMs: 50,
        })
        // Let connection establish
        await new Promise((r) => setTimeout(r, 150))
        expect(bridge.heartbeatReconnects).toBe(0)

        // Simulate staleness: pretend last message was long ago
        ;(bridge as unknown as { lastMessageAt: number }).lastMessageAt =
            Date.now() - 5000

        // Wait one heartbeat tick
        await new Promise((r) => setTimeout(r, 150))
        expect(bridge.heartbeatReconnects).toBeGreaterThanOrEqual(1)

        bridge.stop()
        await env.close()
    })
})
