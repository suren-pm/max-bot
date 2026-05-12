// Per-bot audio fan-out. Receives Float32 frames from the browser-injected
// Web Audio mixer (see audioCapture.ts), resamples to dstSampleRate,
// converts to Int16 PCM, and emits 'chunk' events.
//
// Listeners (e.g. the /ws/:bot_id WebSocket) subscribe via on('chunk').
// On stop(), all listeners are removed so the stream becomes a no-op.

import { EventEmitter } from 'events'

export interface AudioStreamOptions {
    srcSampleRate: number
    dstSampleRate: number
}

export class AudioStream extends EventEmitter {
    private readonly srcSampleRate: number
    private readonly dstSampleRate: number
    private stopped = false

    constructor(opts: AudioStreamOptions) {
        super()
        this.srcSampleRate = opts.srcSampleRate
        this.dstSampleRate = opts.dstSampleRate
    }

    pushFloat32(samples: Float32Array): void {
        if (this.stopped) return
        const int16 = this.resampleAndInt16(samples)
        // Convert Int16Array → little-endian Buffer.
        const buf = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength)
        this.emit('chunk', buf)
    }

    stop(): void {
        this.stopped = true
        this.removeAllListeners()
    }

    private resampleAndInt16(input: Float32Array): Int16Array {
        if (this.srcSampleRate === this.dstSampleRate) {
            const out = new Int16Array(input.length)
            for (let i = 0; i < input.length; i++) {
                const s = Math.max(-1, Math.min(1, input[i]))
                // Use 32767 for both +/- to match int16 symmetric range.
                out[i] = Math.round(s * 32767)
            }
            return out
        }
        const ratio = this.srcSampleRate / this.dstSampleRate
        const outLen = Math.floor(input.length / ratio)
        const out = new Int16Array(outLen)
        for (let i = 0; i < outLen; i++) {
            const srcIdx = i * ratio
            const i0 = Math.floor(srcIdx)
            const i1 = Math.min(i0 + 1, input.length - 1)
            const frac = srcIdx - i0
            const sample = input[i0] * (1 - frac) + input[i1] * frac
            const clamped = Math.max(-1, Math.min(1, sample))
            out[i] = Math.round(clamped * 32767)
        }
        return out
    }
}
