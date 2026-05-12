import { AudioStream } from './audioStream'

describe('AudioStream', () => {
    it('emits chunk events when pushFloat32 is called', () => {
        const stream = new AudioStream({
            srcSampleRate: 48000,
            dstSampleRate: 16000,
        })
        const chunks: Buffer[] = []
        stream.on('chunk', (c: Buffer) => chunks.push(c))

        const input = new Float32Array(4800) // 100 ms @ 48 kHz
        for (let i = 0; i < input.length; i++) input[i] = 0.5
        stream.pushFloat32(input)

        expect(chunks).toHaveLength(1)
        expect(chunks[0].length).toBe(1600 * 2) // 1600 samples * 2 bytes (Int16)
    })

    it('resamples 48 kHz → 16 kHz at 3:1 ratio', () => {
        const stream = new AudioStream({
            srcSampleRate: 48000,
            dstSampleRate: 16000,
        })
        const out: Buffer[] = []
        stream.on('chunk', (c: Buffer) => out.push(c))

        const input = new Float32Array(9600) // 200 ms @ 48 kHz
        stream.pushFloat32(input)

        expect(out).toHaveLength(1)
        expect(out[0].length).toBe(3200 * 2) // 3200 Int16 samples
    })

    it('passes through 1:1 when src === dst sample rate', () => {
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        let captured: Buffer | null = null
        stream.on('chunk', (c: Buffer) => {
            captured = c
        })

        const input = new Float32Array(160) // 10 ms @ 16 kHz
        stream.pushFloat32(input)

        expect(captured).not.toBeNull()
        expect(captured!.length).toBe(160 * 2)
    })

    it('clamps Float32 samples above 1.0 to Int16 max', () => {
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        let captured: Buffer | null = null
        stream.on('chunk', (c: Buffer) => {
            captured = c
        })

        const input = new Float32Array(160)
        input.fill(2.0) // way above range
        stream.pushFloat32(input)

        expect(captured).not.toBeNull()
        // First Int16 sample should be max value 32767.
        const int16 = captured!.readInt16LE(0)
        expect(int16).toBe(32767)
    })

    it('clamps Float32 samples below -1.0 to Int16 min', () => {
        const stream = new AudioStream({
            srcSampleRate: 16000,
            dstSampleRate: 16000,
        })
        let captured: Buffer | null = null
        stream.on('chunk', (c: Buffer) => {
            captured = c
        })

        const input = new Float32Array(160)
        input.fill(-2.0)
        stream.pushFloat32(input)

        expect(captured).not.toBeNull()
        const int16 = captured!.readInt16LE(0)
        expect(int16).toBe(-32767)
    })

    it('stop() removes all listeners and prevents further chunks', () => {
        const stream = new AudioStream({
            srcSampleRate: 48000,
            dstSampleRate: 16000,
        })
        const chunks: Buffer[] = []
        stream.on('chunk', (c: Buffer) => chunks.push(c))
        stream.stop()
        stream.pushFloat32(new Float32Array(4800))
        expect(chunks).toHaveLength(0)
    })
})
