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
import { recordPostmortem } from './postmortem'

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
            // CRITICAL: ffmpeg pulse muxer interprets the positional arg
            // after `-f pulse` as media.name (the application label shown
            // in pavucontrol), NOT the target sink. Without `-device`,
            // libpulse silently falls back to the default sink, which is
            // virtual_speaker (the incoming-audio playback sink). Bytes
            // then go nowhere useful. Always pin the sink explicitly with
            // `-device` so audio lands in virtual_mic_input where the
            // virtual_mic source can pick it up for Chrome's getUserMedia.
            //
            // Root-caused 2026-05-25 during milestone E live testing:
            // /diag/pulse showed ffmpeg's sink-input was on Sink: 1
            // (virtual_speaker) despite passing 'virtual_mic_input' as
            // the positional argument.
            '-f',
            'pulse',
            '-device',
            sink,
            'MaxBotInject',
        ]
        this.child = spawn('ffmpeg', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        // Capture stderr so /diag/inject can surface what ffmpeg is doing.
        // Bumped retention to 200 chunks during Milestone E debug.
        this.child.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            this.stderrTail.push(text)
            if (this.stderrTail.length > 200) {
                this.stderrTail.splice(0, this.stderrTail.length - 200)
            }
        })
        this.child.on('error', (err) => this.emit('error', err))
        this.child.on('exit', (code, signal) => {
            // If we initiated stop(), this is expected — don't record.
            if (!this.stopped) {
                recordPostmortem({
                    kind: 'ffmpeg',
                    pid: this.child?.pid ?? null,
                    exitCode: code ?? null,
                    signal: signal ?? null,
                    stderrTail: this.stderrTail.join('').slice(-2000),
                })
            }
            this.emit('exit', code ?? -1)
        })
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

    isAlive(): boolean {
        return (
            !this.stopped &&
            this.child !== null &&
            !this.child.killed &&
            this.child.exitCode === null
        )
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
