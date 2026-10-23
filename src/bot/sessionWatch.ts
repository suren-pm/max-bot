// Session watchdog (2026-10-23, Phase 4b). Max leaves a meeting once everyone
// else has gone, or when a time limit passes (scheduled standup joins).
//
// "Everyone else has gone" only counts after someone else was seen, so Max can
// wait in an empty room for people to arrive.

import type { Page } from 'playwright'

export type LeaveReason = 'alone' | 'time_limit'

export interface WatchOptions {
    page: Page
    /** Absolute time to leave, if any. */
    leaveAt?: Date | null
    /** How long Max must be alone, after others were seen, before leaving. */
    aloneMs?: number
    intervalMs?: number
    onLeave: (reason: LeaveReason) => void
    now?: () => number
    log?: (msg: string) => void
}

export interface SessionWatch {
    stop: () => void
    /** One check; exposed for tests. */
    tick: () => Promise<void>
}

/** Unique participant tiles on the Meet page, Max's own included. */
export async function countParticipants(page: Page): Promise<number | null> {
    try {
        return await page.evaluate(() => {
            const ids = new Set<string>()
            document.querySelectorAll('[data-participant-id]').forEach((el) => {
                const id = el.getAttribute('data-participant-id')
                if (id) ids.add(id)
            })
            return ids.size
        })
    } catch {
        return null // page closing or navigating; try again next tick
    }
}

export function watchSession(opts: WatchOptions): SessionWatch {
    const aloneMs = opts.aloneMs ?? 120_000
    const now = opts.now ?? Date.now
    const log = opts.log ?? ((m: string) => console.log(m)) // eslint-disable-line no-console
    let othersSeen = false
    let aloneSince: number | null = null
    let lastCount: number | null = null
    let done = false

    const finish = (reason: LeaveReason) => {
        done = true
        clearInterval(timer)
        log(`[watch] leaving: ${reason}`)
        opts.onLeave(reason)
    }

    const tick = async () => {
        if (done) return
        if (opts.leaveAt && now() >= opts.leaveAt.getTime()) return finish('time_limit')
        const n = await countParticipants(opts.page)
        if (n === null || done) return
        if (n !== lastCount) {
            log(`[watch] participants on screen: ${n} (Max included)`)
            lastCount = n
        }
        if (n >= 2) {
            othersSeen = true
            aloneSince = null
            return
        }
        if (!othersSeen) return
        aloneSince = aloneSince ?? now()
        if (now() - aloneSince >= aloneMs) finish('alone')
    }

    const timer = setInterval(() => void tick(), opts.intervalMs ?? 15_000)
    timer.unref?.() // never keep the process alive on its own
    return {
        stop: () => {
            done = true
            clearInterval(timer)
        },
        tick,
    }
}
