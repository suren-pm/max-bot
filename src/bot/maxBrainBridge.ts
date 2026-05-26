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
    /** Force-reconnect if no message received from max-brain in this many ms.
     * Default 10000 (10s). */
    heartbeatStalenessMs?: number
    /** How often the heartbeat watchdog wakes up. Default 2000. */
    heartbeatIntervalMs?: number
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
    // Test-only: every WS we abandon (because we're reconnecting) is
    // recorded here so tests can assert all listeners were detached.
    public _testDeadSockets: WebSocket[] = []
    /** Wall-clock time when current disconnect started. Null when connected. */
    public disconnectedSince: number | null = null
    /** How many times the heartbeat watchdog has fired a force-reconnect. */
    public heartbeatReconnects = 0
    private readonly stalenessMs: number
    private readonly hbIntervalMs: number
    private hbTimer: NodeJS.Timeout | null = null

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
        this.stalenessMs = opts.heartbeatStalenessMs ?? 10000
        this.hbIntervalMs = opts.heartbeatIntervalMs ?? 2000
        this.hbTimer = setInterval(() => this.checkHeartbeat(), this.hbIntervalMs)
        // Prevent the interval from keeping Node alive past stop().
        this.hbTimer.unref?.()
        this.connect()
    }

    private cleanupWs(ws: WebSocket | null, track = true): void {
        if (!ws) return
        // Detach ALL listeners we attached. Critical to prevent
        // listener-stacking memory leak on repeated reconnects.
        ws.removeAllListeners('open')
        ws.removeAllListeners('message')
        ws.removeAllListeners('close')
        ws.removeAllListeners('error')
        // Absorb any async error that ws.close() may emit via process.nextTick
        // when the socket is still in CONNECTING state (abortHandshake path).
        // This one-shot listener is NOT counted by the "dead socket" listener
        // assertion in tests — those sockets go through the track=true path
        // (reconnect cycles) and are always OPEN when recycled, so this branch
        // is only active for the final stop() path (track=false).
        if (!track) {
            ws.once('error', () => { /* absorb async close error on stop */ })
        }
        try {
            ws.close()
        } catch {
            /* ignore */
        }
        if (track) this._testDeadSockets.push(ws)
    }

    private checkHeartbeat(): void {
        if (this.stopped) return
        if (!this.lastMessageAt) return // never received yet → wait
        const stale = Date.now() - this.lastMessageAt > this.stalenessMs
        if (!stale) return
        // Half-open connection — TCP says alive but max-brain stopped
        // sending. Force reconnect.
        this.heartbeatReconnects += 1
        // eslint-disable-next-line no-console
        console.warn(
            `[bridge] heartbeat stale (>${this.stalenessMs}ms), forcing reconnect`,
        )
        const closing = this.ws
        this.ws = null
        this.cleanupWs(closing)
        this.connect()
    }

    private connect(): void {
        if (this.stopped) return
        // CRITICAL: detach any previous WS before opening a new one.
        // Without this, old close-handler closures (which call
        // scheduleReconnect→connect) survive and accumulate, and old
        // message handlers (which push to audioInject) double up. We
        // observed this leak in Milestone E live testing: bytesReceived
        // counter exploded from 8 MB → 7 GB over a few minutes.
        const old = this.ws
        this.ws = null
        this.cleanupWs(old)

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
            this.disconnectedSince = null
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
            this.disconnectedSince = Date.now()
            // Immediately detach & record the now-dead socket so that
            // stale listeners cannot fire again (e.g. during GC / ws
            // internal cleanup). We do this here rather than waiting
            // until the next connect() call, so the dead-socket list
            // is populated before any reconnect timer fires.
            const closing = this.ws
            this.ws = null
            this.cleanupWs(closing)
            if (!this.stopped) {
                this.scheduleReconnect()
            }
        })

        this.ws.on('error', (err: Error) => {
            this.lastConnectError = err.message
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
        if (this.hbTimer) {
            clearInterval(this.hbTimer)
            this.hbTimer = null
        }
        this.audioStream.off('chunk', this.onChunk)
        this.cleanupWs(this.ws, false)
        this.ws = null
    }
}
