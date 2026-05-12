// Mock child_process.spawn BEFORE importing audioInject.
jest.mock('child_process', () => {
    const writeMock = jest.fn()
    const endMock = jest.fn()
    const killMock = jest.fn()
    const onErrorListeners: Array<(e: Error) => void> = []
    const onExitListeners: Array<(code: number) => void> = []
    const stdinDestroyedFlag = { destroyed: false }

    const fakeChild = {
        stdin: {
            write: writeMock,
            end: endMock,
            get destroyed() {
                return stdinDestroyedFlag.destroyed
            },
        },
        stderr: {
            on: jest.fn(),
        },
        on: (ev: string, cb: (...a: unknown[]) => void) => {
            if (ev === 'error') onErrorListeners.push(cb as (e: Error) => void)
            if (ev === 'exit') onExitListeners.push(cb as (code: number) => void)
        },
        kill: killMock,
        pid: 12345,
        killed: false,
    }

    const spawnMock = jest.fn(() => fakeChild)

    return {
        spawn: spawnMock,
        __mocks__: {
            spawnMock,
            writeMock,
            endMock,
            killMock,
            stdinDestroyedFlag,
            triggerExit: (code: number) =>
                onExitListeners.forEach((f) => f(code)),
            triggerError: (e: Error) =>
                onErrorListeners.forEach((f) => f(e)),
        },
    }
})

import * as child_process from 'child_process'

import { AudioInject } from './audioInject'

const mocks = (
    child_process as unknown as {
        __mocks__: {
            spawnMock: jest.Mock
            writeMock: jest.Mock
            endMock: jest.Mock
            killMock: jest.Mock
            stdinDestroyedFlag: { destroyed: boolean }
            triggerExit: (code: number) => void
            triggerError: (e: Error) => void
        }
    }
).__mocks__

describe('AudioInject', () => {
    beforeEach(() => {
        mocks.spawnMock.mockClear()
        mocks.writeMock.mockClear()
        mocks.endMock.mockClear()
        mocks.killMock.mockClear()
        mocks.stdinDestroyedFlag.destroyed = false
    })

    it('spawns ffmpeg with f32le float-input + s16le FIFO output', () => {
        new AudioInject({
            sampleRate: 16000,
            fifoPath: '/tmp/pulse/virtual_mic.fifo',
        })
        const cmd = mocks.spawnMock.mock.calls[0][0]
        const args = mocks.spawnMock.mock.calls[0][1] as string[]
        expect(cmd).toBe('ffmpeg')
        expect(args).toEqual(
            expect.arrayContaining([
                '-f',
                'f32le',
                '-ar',
                '16000',
                '-ac',
                '1',
                '-i',
                '-',
                '-f',
                's16le',
                '/tmp/pulse/virtual_mic.fifo',
            ]),
        )
    })

    it('defaults fifoPath to /tmp/pulse/virtual_mic.fifo', () => {
        new AudioInject({ sampleRate: 16000 })
        const args = mocks.spawnMock.mock.calls[0][1] as string[]
        expect(args).toContain('/tmp/pulse/virtual_mic.fifo')
        expect(args).toContain('s16le')
    })

    it('converts Int16 LE buffer to Float32 LE and writes to stdin', () => {
        const inj = new AudioInject({ sampleRate: 16000 })
        // 4 Int16 samples [16384, -16384, 32767, -32768] little-endian
        const buf = Buffer.alloc(8)
        buf.writeInt16LE(16384, 0)
        buf.writeInt16LE(-16384, 2)
        buf.writeInt16LE(32767, 4)
        buf.writeInt16LE(-32768, 6)

        inj.pushInt16Buffer(buf)

        expect(mocks.writeMock).toHaveBeenCalled()
        const written: Buffer = mocks.writeMock.mock.calls[0][0]
        expect(written.length).toBe(16) // 4 samples × 4 bytes (Float32)
        const f32 = new Float32Array(
            written.buffer,
            written.byteOffset,
            4,
        )
        expect(f32[0]).toBeCloseTo(16384 / 32768, 3)
        expect(f32[1]).toBeCloseTo(-16384 / 32768, 3)
        expect(f32[2]).toBeCloseTo(32767 / 32768, 3)
        expect(f32[3]).toBeCloseTo(-32768 / 32768, 3)
    })

    it('stop() ends ffmpeg stdin and kills the process', () => {
        const inj = new AudioInject({ sampleRate: 16000 })
        inj.stop()
        expect(mocks.endMock).toHaveBeenCalled()
        expect(mocks.killMock).toHaveBeenCalledWith('SIGTERM')
    })

    it('stop() is idempotent', () => {
        const inj = new AudioInject({ sampleRate: 16000 })
        inj.stop()
        inj.stop()
        expect(mocks.endMock).toHaveBeenCalledTimes(1)
        expect(mocks.killMock).toHaveBeenCalledTimes(1)
    })

    it('pushInt16Buffer is a no-op after stop()', () => {
        const inj = new AudioInject({ sampleRate: 16000 })
        inj.stop()
        const buf = Buffer.alloc(4)
        buf.writeInt16LE(1000, 0)
        buf.writeInt16LE(2000, 2)
        inj.pushInt16Buffer(buf)
        expect(mocks.writeMock).not.toHaveBeenCalled()
    })

    it('emits "exit" event when the ffmpeg subprocess exits', (done) => {
        const inj = new AudioInject({ sampleRate: 16000 })
        inj.on('exit', (code: number) => {
            expect(code).toBe(0)
            done()
        })
        mocks.triggerExit(0)
    })
})
