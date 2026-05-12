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
    /**
     * Linear gain applied before Int16 clipping.
     * Web Audio MediaStreamDestination outputs WebRTC remote tracks at
     * heavily attenuated amplitude — empirically ~8% of full-scale even
     * for speech that registers as clear voice in the Meet UI. A gain
     * of 20 lands speech in the -3 to -6 dBFS range without distortion
     * for typical inputs.
     */
    gain?: number
}

export class AudioStream extends EventEmitter {
    private readonly srcSampleRate: number
    private readonly dstSampleRate: number
    private readonly gain: number
    private stopped = false

    constructor(opts: AudioStreamOptions) {
        super()
        this.srcSampleRate = opts.srcSampleRate
        this.dstSampleRate = opts.dstSampleRate
        this.gain = opts.gain ?? 20
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
        const g = this.gain
        if (this.srcSampleRate === this.dstSampleRate) {
            const out = new Int16Array(input.length)
            for (let i = 0; i < input.length; i++) {
                const s = Math.max(-1, Math.min(1, input[i] * g))
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
            const clamped = Math.max(-1, Math.min(1, sample * g))
            out[i] = Math.round(clamped * 32767)
        }
        return out
    }
}
