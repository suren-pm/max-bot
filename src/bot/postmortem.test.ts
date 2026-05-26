// src/bot/postmortem.test.ts
import {
    _clearPostmortems,
    getAllPostmortems,
    getLatestPostmortem,
    recordPostmortem,
} from './postmortem'

describe('postmortem', () => {
    afterEach(() => {
        _clearPostmortems()
    })

    it('records a postmortem with timestamp', () => {
        recordPostmortem({
            kind: 'ffmpeg',
            pid: 42,
            exitCode: 1,
            signal: null,
            stderrTail: 'pulse: connection refused',
        })
        const latest = getLatestPostmortem()
        expect(latest).not.toBeNull()
        expect(latest?.kind).toBe('ffmpeg')
        expect(latest?.pid).toBe(42)
        expect(latest?.exitCode).toBe(1)
        expect(latest?.stderrTail).toBe('pulse: connection refused')
        expect(typeof latest?.timestamp).toBe('number')
    })

    it('getLatestPostmortem returns null when empty', () => {
        expect(getLatestPostmortem()).toBeNull()
    })

    it('getAllPostmortems returns in newest-first order', () => {
        recordPostmortem({
            kind: 'ffmpeg',
            pid: 1,
            exitCode: 1,
            signal: null,
            stderrTail: 'first',
        })
        recordPostmortem({
            kind: 'chromium',
            pid: 2,
            exitCode: null,
            signal: 'SIGKILL',
            stderrTail: 'second',
        })
        const all = getAllPostmortems()
        expect(all).toHaveLength(2)
        expect(all[0].stderrTail).toBe('second')
        expect(all[1].stderrTail).toBe('first')
    })

    it('trims to last 20 entries', () => {
        for (let i = 0; i < 25; i++) {
            recordPostmortem({
                kind: 'ffmpeg',
                pid: i,
                exitCode: i,
                signal: null,
                stderrTail: `event-${i}`,
            })
        }
        const all = getAllPostmortems()
        expect(all).toHaveLength(20)
        expect(all[0].stderrTail).toBe('event-24')
        expect(all[19].stderrTail).toBe('event-5')
    })
})
