// macOS voice OUT (Phase 2, Option D, 2026-10-22).
//
// Linux used ffmpeg -> PulseAudio virtual_mic, which does not exist on
// macOS. Instead, Max's voice is produced INSIDE the Meet page: an init
// script replaces navigator.mediaDevices.getUserMedia so Meet's
// "microphone" is a Web Audio MediaStreamDestination, and Node feeds it
// PCM via page.evaluate. No OS audio driver, no subprocess.
//
// Mirror image of audioCapture.ts, which reads remote tracks in-page.
// Side effect by design: Meet never opens the Mac's real microphone.

import type { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import type { Page } from 'playwright'
import type { AudioInjector } from './audioInjector'

// Runs in the page before any Meet JavaScript. Must be self-contained:
// it is serialized with .toString() by page.addInitScript.
/* eslint-disable @typescript-eslint/no-explicit-any */
function installMaxInject(): void {
    const w = window as any
    if (w.__maxInject) return
    const state: any = {
        installed: true,
        ctxState: null,
        pushes: 0,
        samples: 0,
        resyncs: 0,
        gumCalls: 0,
        gumAudioServed: 0,
        videoBlocked: 0,
        lastError: null,
    }
    w.__maxInject = state
    let ctx: AudioContext | null = null
    let dest: MediaStreamAudioDestinationNode | null = null
    let nextTime = 0
    const LEAD_S = 0.08 // small jitter buffer at the start of each utterance

    const ensure = (): void => {
        if (ctx) return
        const AC = w.AudioContext || w.webkitAudioContext
        ctx = new AC() as AudioContext
        dest = ctx.createMediaStreamDestination()
        // Keep the outgoing track producing frames while Max is silent.
        const keepAlive = ctx.createConstantSource()
        keepAlive.offset.value = 0
        keepAlive.connect(dest)
        keepAlive.start()
        state.ctxState = ctx.state
    }

    state.push = (samples: number[], rate: number): void => {
        try {
            ensure()
            const c = ctx as AudioContext
            if (c.state === 'suspended') c.resume().catch(() => undefined)
            const buf = c.createBuffer(1, samples.length, rate)
            buf.copyToChannel(Float32Array.from(samples), 0)
            const src = c.createBufferSource()
            src.buffer = buf
            src.connect(dest as MediaStreamAudioDestinationNode)
            const now = c.currentTime
            if (nextTime < now + 0.02) {
                // New utterance (or a gap): restart the schedule slightly ahead.
                if (state.pushes > 0) state.resyncs++
                nextTime = now + LEAD_S
            }
            src.start(nextTime)
            nextTime += buf.duration
            state.pushes++
            state.samples += samples.length
            state.ctxState = c.state
        } catch (e) {
            state.lastError = String((e && (e as Error).message) || e)
        }
    }

    const md = navigator.mediaDevices
    if (md && typeof md.getUserMedia === 'function') {
        const orig = md.getUserMedia.bind(md)
        md.getUserMedia = async (
            constraints?: MediaStreamConstraints,
        ): Promise<MediaStream> => {
            state.gumCalls++
            // Max is audio-only. NEVER open a camera, whatever permissions or
            // --use-fake-ui-for-media-stream would allow: on a Mac that is the
            // real FaceTime camera.
            if (constraints && constraints.video) state.videoBlocked++
            if (constraints && constraints.audio) {
                ensure()
                state.gumAudioServed++
                return new MediaStream(
                    (dest as MediaStreamAudioDestinationNode).stream
                        .getAudioTracks()
                        .map((t) => t.clone()),
                )
            }
            if (constraints && constraints.video) {
                throw new DOMException(
                    'Camera disabled: Max is an audio-only bot',
                    'NotAllowedError',
                )
            }
            return orig(constraints)
        }
    }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface InPageAudioInjectOptions {
    sampleRate: number
}

export class InPageAudioInject extends EventEmitter implements AudioInjector {
    public readonly child: ChildProcess | null = null
    public stderrTail: string[] = []
    public readonly stats = {
        pushedChunks: 0,
        deliveredBatches: 0,
        deliveredSamples: 0,
        errors: 0,
    }
    private page: Page | null = null
    private stopped = false
    private pending: Float32Array[] = []
    private flushing = false

    constructor(private readonly opts: InPageAudioInjectOptions) {
        super()
    }

    /** Must run BEFORE page.goto (joinMeet's onPageReady hook). */
    async attach(page: Page): Promise<void> {
        this.page = page
        await page.addInitScript(installMaxInject)
    }

    /** Accepts a buffer of little-endian Int16 PCM samples. */
    pushInt16Buffer(buf: Buffer): void {
        if (this.stopped || !this.page) return
        const n = Math.floor(buf.length / 2)
        if (n === 0) return
        const f32 = new Float32Array(n)
        for (let i = 0; i < n; i++) f32[i] = buf.readInt16LE(i * 2) / 32768
        this.pending.push(f32)
        this.stats.pushedChunks++
        void this.flush()
    }

    // Serialize page.evaluate calls; coalesce whatever queued meanwhile.
    private async flush(): Promise<void> {
        if (this.flushing) return
        this.flushing = true
        try {
            while (!this.stopped && this.page && this.pending.length > 0) {
                const batch = this.pending.splice(0, this.pending.length)
                const total = batch.reduce((a, b) => a + b.length, 0)
                const merged = new Float32Array(total)
                let off = 0
                for (const b of batch) {
                    merged.set(b, off)
                    off += b.length
                }
                try {
                    await this.page.evaluate(
                        ([samples, rate]: [number[], number]) => {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const s = (window as any).__maxInject
                            if (s && s.push) s.push(samples, rate)
                        },
                        [Array.from(merged), this.opts.sampleRate] as [
                            number[],
                            number,
                        ],
                    )
                    this.stats.deliveredBatches++
                    this.stats.deliveredSamples += total
                } catch (err) {
                    this.stats.errors++
                    this.stderrTail.push(
                        `[inpage] ${err instanceof Error ? err.message : String(err)}\n`,
                    )
                    if (this.stderrTail.length > 200) {
                        this.stderrTail.splice(0, this.stderrTail.length - 200)
                    }
                }
            }
        } finally {
            this.flushing = false
        }
    }

    /** In-page counters for /diag/inject (without the push function). */
    async getPageState(): Promise<Record<string, unknown> | null> {
        if (!this.page || this.page.isClosed()) return null
        try {
            return await this.page.evaluate(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const s = (window as any).__maxInject
                if (!s) return null
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { push, ...rest } = s
                return rest
            })
        } catch {
            return null
        }
    }

    isAlive(): boolean {
        return !this.stopped && !!this.page && !this.page.isClosed()
    }

    stop(): void {
        this.stopped = true
        this.pending = []
    }
}
