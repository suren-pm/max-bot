// Per-bot ffmpeg subprocess that converts incoming Int16 PCM (from
// the /ws_in/:bot_id WebSocket) into Float32 and pipes it into the
// PulseAudio `virtual_mic` source via ALSA's pulse plugin.
//
// Chrome (launched with --use-fake-ui-for-media-stream) auto-grants
// the bot's outgoing mic; whatever is on virtual_mic becomes Max's
// voice in the Meet call. We set virtual_mic as PulseAudio's default
// source in /start.sh so getUserMedia picks it up automatically.
//
// Pattern reference: src/streaming.ts:560-607 + src/media_context.ts:145-166.
// We don't import — same decoupling reasons as audioCapture.ts.

import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'

export interface AudioInjectOptions {
    sampleRate: number
    /**
     * Path to the FIFO PulseAudio's pipe-source reads from.
     * /start.sh creates this with mkfifo before loading module-pipe-source.
     */
    fifoPath?: string
}

export class AudioInject extends EventEmitter {
    public readonly child: ChildProcess
    public stderrTail: string[] = []
    private stopped = false

    constructor(opts: AudioInjectOptions) {
        super()
        const fifo = opts.fifoPath ?? '/tmp/pulse/virtual_mic.fifo'
        // Write Int16 s16le raw audio to the FIFO. PulseAudio's
        // module-pipe-source reads from that FIFO and exposes it as the
        // virtual_mic source which Chrome's getUserMedia uses.
        //
        // Why a FIFO instead of -f pulse:
        //   module-virtual-source without master= silently loopbacks from
        //   virtual_speaker.monitor, causing acoustic feedback (Suren hears
        //   his own voice through Max). module-pipe-source has no such
        //   loopback path — bytes only come from the FIFO.
        const args = [
            '-loglevel',
            'warning',
            '-f',
            'f32le',
            '-ar',
            String(opts.sampleRate),
            '-ac',
            '1',
            '-i',
            '-',
            '-f',
            's16le',
            '-ar',
            '16000',
            '-ac',
            '1',
            fifo,
        ]
        this.child = spawn('ffmpeg', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        // Capture stderr so /diag/inject can surface why ffmpeg died.
        this.child.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            this.stderrTail.push(text)
            // Keep only the last ~10 lines worth.
            if (this.stderrTail.length > 20) {
                this.stderrTail.splice(0, this.stderrTail.length - 20)
            }
        })
        this.child.on('error', (err) => this.emit('error', err))
        this.child.on('exit', (code) => this.emit('exit', code ?? -1))
    }

    /** Accepts a buffer of little-endian Int16 PCM samples. */
    pushInt16Buffer(buf: Buffer): void {
        if (this.stopped) return
        const stdin = this.child.stdin
        if (!stdin || stdin.destroyed) return
        const n = buf.length / 2
        const f32 = new Float32Array(n)
        for (let i = 0; i < n; i++) {
            const s = buf.readInt16LE(i * 2)
            f32[i] = s / 32768
        }
        const out = Buffer.from(
            f32.buffer,
            f32.byteOffset,
            f32.byteLength,
        )
        stdin.write(out)
    }

    stop(): void {
        if (this.stopped) return
        this.stopped = true
        try {
            this.child.stdin?.end()
        } catch {
            /* ignore */
        }
        try {
            this.child.kill('SIGTERM')
        } catch {
            /* ignore */
        }
    }
}
