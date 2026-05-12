import { AudioStream } from './audioStream'
import {
    _clearAllSessions,
    getSession,
    hasActiveSession,
    JoinSession,
    registerSession,
    removeSession,
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
