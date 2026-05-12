import { AudioStream } from './audioStream'
import { attachAudioCapture } from './audioCapture'

interface FakePage {
    exposedFunctions: Map<string, (...args: unknown[]) => unknown>
    exposeFunction: jest.Mock
    addInitScript: jest.Mock
    evaluate: jest.Mock
}

function makeFakePage(): FakePage {
    const exposedFunctions = new Map<string, (...args: unknown[]) => unknown>()
    const exposeFunction = jest.fn(
        async (name: string, fn: (...a: unknown[]) => unknown) => {
            exposedFunctions.set(name, fn)
        },
    )
    return {
        exposedFunctions,
        exposeFunction,
        addInitScript: jest.fn(async () => {}),
        evaluate: jest.fn(async () => {}),
    }
}

describe('attachAudioCapture', () => {
    it('exposes maxBotPushAudioFrame and calls it pushes samples into the AudioStream', async () => {
        const page = makeFakePage()
        const stream = new AudioStream({
            srcSampleRate: 48000,
            dstSampleRate: 16000,
        })
        const chunks: Buffer[] = []
        stream.on('chunk', (c: Buffer) => chunks.push(c))

        await attachAudioCapture(page as never, stream)

        expect(page.exposeFunction).toHaveBeenCalledWith(
            'maxBotPushAudioFrame',
            expect.any(Function),
        )

        // Simulate the browser calling the exposed function with a chunk.
        const pushFn = page.exposedFunctions.get('maxBotPushAudioFrame')!
        const fakeChunk = {
            audioData: new Array(4800).fill(0.1), // 100 ms @ 48 kHz
            sampleRate: 48000,
            timestamp: 0,
            numberOfFrames: 4800,
        }
        await pushFn(fakeChunk)

        expect(chunks).toHaveLength(1)
        // 100 ms @ 48k → 1600 samples @ 16k → 3200 bytes
        expect(chunks[0].length).toBe(3200)
    })

    it('forwards the browser-reported sample rate (handles 48k or other rates)', async () => {
        const page = makeFakePage()
        const stream = new AudioStream({
            srcSampleRate: 48000,
            dstSampleRate: 16000,
        })
        const captured: number[] = []
        // Spy on pushFloat32 so we can record the input length.
        const origPush = stream.pushFloat32.bind(stream)
        stream.pushFloat32 = (arr: Float32Array) => {
            captured.push(arr.length)
            origPush(arr)
        }
        await attachAudioCapture(page as never, stream)
        const pushFn = page.exposedFunctions.get('maxBotPushAudioFrame')!
        await pushFn({
            audioData: new Array(960).fill(0),
            sampleRate: 48000,
            timestamp: 0,
            numberOfFrames: 960,
        })
        expect(captured).toEqual([960])
    })

    it('injects an init script that contains the audio capture setup', async () => {
        const page = makeFakePage()
        const stream = new AudioStream({
            srcSampleRate: 48000,
            dstSampleRate: 16000,
        })
        await attachAudioCapture(page as never, stream)
        expect(page.addInitScript).toHaveBeenCalled()
        const callArg = page.addInitScript.mock.calls[0][0] as unknown
        const scriptStr =
            typeof callArg === 'function' ? callArg.toString() : String(callArg)
        expect(scriptStr).toContain('maxBotPushAudioFrame')
        // Sanity checks that the proven upstream techniques are present.
        expect(scriptStr).toContain('RTCPeerConnection')
        expect(scriptStr).toContain('MediaStreamTrackProcessor')
    })

    it('ignores duplicate exposeFunction calls (idempotent for reconnects)', async () => {
        const page = makeFakePage()
        // Make exposeFunction throw on second call (Playwright behaviour).
        let calls = 0
        page.exposeFunction.mockImplementation(async () => {
            calls++
            if (calls > 1) {
                throw new Error(
                    'Function "maxBotPushAudioFrame" has been already registered',
                )
            }
        })

        const stream = new AudioStream({
            srcSampleRate: 48000,
            dstSampleRate: 16000,
        })
        await attachAudioCapture(page as never, stream)
        await expect(
            attachAudioCapture(page as never, stream),
        ).resolves.not.toThrow()
    })
})
