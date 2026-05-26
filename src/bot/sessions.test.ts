import { AudioStream } from './audioStream'
import {
    _clearAllSessions,
    getSession,
    hasActiveSession,
    JoinSession,
    registerSession,
    removeSession,
    withTimeout,
} from './sessions'

function makeAudioStream(): AudioStream {
    return new AudioStream({ srcSampleRate: 48000, dstSampleRate: 16000 })
}

describe('bot/sessions', () => {
    afterEach(() => {
        _clearAllSessions()
    })

    it('registers and retrieves a session by bot_id', () => {
        const session: JoinSession = {
            bot_id: 'bot-1',
            meeting_url: 'https://meet.google.com/abc-defg-hij',
            bot_name: 'Max',
            startedAt: new Date('2026-05-11T00:00:00Z'),
            audioStream: makeAudioStream(),
            audioInject: {} as never,
            maxBrainBridge: {} as never,
            page: {} as never,
            close: jest.fn(async () => {}),
        }
        registerSession(session)
        expect(getSession('bot-1')).toBe(session)
    })

    it('returns undefined for unknown bot_id', () => {
        expect(getSession('nope')).toBeUndefined()
    })

    it('reports active session presence', () => {
        expect(hasActiveSession()).toBe(false)
        registerSession({
            bot_id: 'bot-2',
            meeting_url: 'https://meet.google.com/xyz',
            bot_name: 'Max',
            startedAt: new Date(),
            audioStream: makeAudioStream(),
            audioInject: {} as never,
            maxBrainBridge: {} as never,
            page: {} as never,
            close: jest.fn(async () => {}),
        })
        expect(hasActiveSession()).toBe(true)
        removeSession('bot-2')
        expect(hasActiveSession()).toBe(false)
    })

    it('removeSession is a no-op for unknown bot_id', () => {
        expect(() => removeSession('nope')).not.toThrow()
    })
})

describe('withTimeout', () => {
    it('resolves with the inner value when inner resolves before timeout', async () => {
        const result = await withTimeout(
            Promise.resolve('ok'),
            1000,
            'fast',
        )
        expect(result).toEqual({ timedOut: false, value: 'ok', label: 'fast' })
    })

    it('returns timedOut=true when inner takes longer than ms', async () => {
        const slow = new Promise((resolve) => setTimeout(resolve, 200))
        const result = await withTimeout(slow, 50, 'slow')
        expect(result.timedOut).toBe(true)
    })

    it('does not throw when inner rejects after timeout', async () => {
        const failsLate = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('late')), 200),
        )
        const result = await withTimeout(failsLate, 50, 'fail-late')
        expect(result.timedOut).toBe(true)
        // Awaiting later doesn't propagate — just verifying no unhandled rejection
        await new Promise((r) => setTimeout(r, 250))
    })
})
