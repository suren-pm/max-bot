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
     * PulseAudio sink name to write audio into. Default 'virtual_mic_input'.
     * The sinks monitor is the master of the virtual_mic source, so audio
     * written here surfaces as Max microphone in Chrome getUserMedia.
     */
    pulseSink?: string
}

export class AudioInject extends EventEmitter {
    public readonly child: ChildProcess
    public stderrTail: string[] = []
    private stopped = false

    constructor(opts: AudioInjectOptions) {
        super()
        const sink = opts.pulseSink ?? 'virtual_mic_input'
        // Write Float32 audio into a PulseAudio sink. The sink is a
        // null-sink in /start.sh whose monitor is set as the master of
        // the virtual_mic source. Chrome getUserMedia reads from
        // virtual_mic, so what we write here becomes Max mic.
        //
        // Why a sink (not module-pipe-source / FIFO): Milestone D v1
        // attempted module-pipe-source with FIFOs; that approach hit a
        // PulseAudio startup failure we could not root-cause in 5 PRs.
        // The null-sink-monitor to virtual-source pattern is canonical
        // PulseAudio and avoids that whole class of problem.
        //
        // Why -f pulse (not -f alsa pulse:foo): libasound2-plugins is
        // not installed in the upstream Dockerfile, so the ALSA pulse
        // plugin is not available. -f pulse uses libpulse directly,
        // which IS installed via pulseaudio-utils.
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
            'pulse',
            sink,
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
