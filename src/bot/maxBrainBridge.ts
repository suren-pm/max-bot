// WebSocket client that connects out to max-brain's /ws/{bot_id}
// endpoint and bridges audio in both directions:
//   - AudioStream chunks (captured Meet audio) -> ws.send (binary)
//   - ws.on('message') binary frames           -> AudioInject.pushInt16Buffer
//
// This mirrors MBaaS's WebSocket client behaviour: max-brain's
// /ws/{bot_id} server is unchanged, max-bot just plays the role
// MBaaS used to.

import { WebSocket } from 'ws'

import type { AudioInject } from './audioInject'
import type { AudioStream } from './audioStream'

export interface MaxBrainBridgeOptions {
    /** Base WS URL, e.g. wss://max-brain-production.up.railway.app/ws */
    wsUrl: string
    botId: string
    audioStream: AudioStream
    audioInject: AudioInject
}

export class MaxBrainBridge {
    private ws: WebSocket | null = null
    private stopped = false
    private readonly fullUrl: string
    private readonly audioStream: AudioStream
    private readonly audioInject: AudioInject
    private readonly onChunk: (buf: Buffer) => void
    private reconnectAttempts = 0
    private readonly maxReconnects = 5

    constructor(opts: MaxBrainBridgeOptions) {
        this.fullUrl = `${opts.wsUrl}/${opts.botId}`
        this.audioStream = opts.audioStream
        this.audioInject = opts.audioInject
        // Stable function reference so we can off() it later.
        this.onChunk = (buf: Buffer) => {
            if (
                this.ws &&
                this.ws.readyState === WebSocket.OPEN
            ) {
                this.ws.send(buf, { binary: true })
            }
        }
        this.audioStream.on('chunk', this.onChunk)
        this.connect()
    }

    private connect(): void {
        if (this.stopped) return
        try {
            this.ws = new WebSocket(this.fullUrl)
        } catch (err) {
            this.scheduleReconnect()
            return
        }

        this.ws.on('open', () => {
            this.reconnectAttempts = 0
        })

        this.ws.on('message', (m: unknown) => {
            if (m instanceof Buffer) {
                this.audioInject.pushInt16Buffer(m)
            }
        })

        this.ws.on('close', () => {
            if (!this.stopped) {
                this.scheduleReconnect()
            }
        })

        this.ws.on('error', () => {
            // Errors trigger 'close' afterwards; reconnect logic lives there.
        })
    }

    private scheduleReconnect(): void {
        if (this.stopped) return
        if (this.reconnectAttempts >= this.maxReconnects) return
        this.reconnectAttempts += 1
        const delayMs = Math.min(
            1000 * Math.pow(2, this.reconnectAttempts - 1),
            10000,
        )
        setTimeout(() => this.connect(), delayMs)
    }

    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN
    }

    stop(): void {
        if (this.stopped) return
        this.stopped = true
        this.audioStream.off('chunk', this.onChunk)
        try {
            this.ws?.close()
        } catch {
            /* ignore */
        }
    }
}
