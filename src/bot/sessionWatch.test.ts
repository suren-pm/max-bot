import { watchSession } from './sessionWatch'

function fakePage(counts: number[]) {
    let i = 0
    return {
        evaluate: jest.fn(async () => counts[Math.min(i++, counts.length - 1)]),
    } as never
}

describe('watchSession', () => {
    let t = 0
    const now = () => t
    const log = () => {}
    beforeEach(() => {
        t = 0
    })

    it('waits in an empty room: never leaves before anyone else joined', async () => {
        const onLeave = jest.fn()
        const w = watchSession({ page: fakePage([1, 1, 1, 1]), onLeave, now, log, aloneMs: 1000 })
        for (let k = 0; k < 4; k++) {
            t += 5000
            await w.tick()
        }
        w.stop()
        expect(onLeave).not.toHaveBeenCalled()
    })

    it('leaves once everyone else has gone for aloneMs', async () => {
        const onLeave = jest.fn()
        const w = watchSession({ page: fakePage([2, 3, 1, 1, 1]), onLeave, now, log, aloneMs: 2000 })
        await w.tick() // 2 people
        await w.tick() // 3 people
        await w.tick() // alone, starts the clock at t=0
        t = 1000
        await w.tick() // alone 1 s
        expect(onLeave).not.toHaveBeenCalled()
        t = 2500
        await w.tick() // alone 2.5 s
        expect(onLeave).toHaveBeenCalledWith('alone')
        w.stop()
    })

    it('someone coming back resets the alone clock', async () => {
        const onLeave = jest.fn()
        const w = watchSession({ page: fakePage([2, 1, 2, 1, 1]), onLeave, now, log, aloneMs: 2000 })
        await w.tick() // 2
        await w.tick() // alone at t=0
        t = 1500
        await w.tick() // back to 2
        t = 3000
        await w.tick() // alone again at t=3000
        t = 4000
        await w.tick() // only 1 s alone
        expect(onLeave).not.toHaveBeenCalled()
        w.stop()
    })

    it('leaves at the time limit even with people present', async () => {
        const onLeave = jest.fn()
        const w = watchSession({
            page: fakePage([3]), onLeave, now, log, leaveAt: new Date(10_000),
        })
        t = 9000
        await w.tick()
        expect(onLeave).not.toHaveBeenCalled()
        t = 10_000
        await w.tick()
        expect(onLeave).toHaveBeenCalledWith('time_limit')
        w.stop()
    })
})
