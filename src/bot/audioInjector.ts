// Common surface for Max's voice-OUT implementations, so sessions and the
// max-brain bridge accept either:
//   - AudioInject        (Linux: ffmpeg -> PulseAudio virtual_mic)
//   - InPageAudioInject  (macOS: in-page getUserMedia replacement)
import type { ChildProcess } from 'child_process'

export interface AudioInjector {
    /** Little-endian Int16 PCM at the injector's configured sample rate. */
    pushInt16Buffer(buf: Buffer): void
    isAlive(): boolean
    stop(): void
    /** ffmpeg subprocess (Linux only); null for the in-page injector. */
    readonly child: ChildProcess | null
    stderrTail: string[]
}
