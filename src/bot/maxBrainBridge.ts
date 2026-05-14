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
    /** Diagnostic counters — exposed via app.ts /diag for live debugging. */
    public bytesReceivedFromBrain = 0
    public messagesReceivedFromBrain = 0
    public bytesSentToBrain = 0
    public chunksSentToBrain = 0
    public lastConnectError: string | null = null
    public lastOpenAt: number | null = null
    public lastCloseAt: number | null = null
    public lastCloseCode: number | null = null
    public lastMessageAt: number | null = null

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
                this.bytesSentToBrain += buf.length
                this.chunksSentToBrain += 1
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
            this.lastConnectError =
                err instanceof Error ? err.message : String(err)
            this.scheduleReconnect()
            return
        }

        this.ws.on('open', () => {
            this.reconnectAttempts = 0
            this.lastOpenAt = Date.now()
            this.lastConnectError = null
        })

        this.ws.on('message', (m: unknown) => {
            this.messagesReceivedFromBrain += 1
            this.lastMessageAt = Date.now()
            if (m instanceof Buffer) {
                this.bytesReceivedFromBrain += m.length
                this.audioInject.pushInt16Buffer(m)
            }
        })

        this.ws.on('close', (code: number) => {
            this.lastCloseAt = Date.now()
            this.lastCloseCode = code
            if (!this.stopped) {
                this.scheduleReconnect()
            }
        })

        this.ws.on('error', (err: Error) => {
            this.lastConnectError = err.message
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
