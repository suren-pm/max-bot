// macOS audio routing for Max (2026-10-22).
//
// Problem: on the Mac, Max's in-page capture of Meet's WebRTC tracks yields
// all-zero audio (Suren's real voice, 180 s, peak 0.000), while Max's tab
// still PLAYS the meeting out of the speakers, echoing participants.
//
// Fix: send everything Max's tab plays into the BlackHole 2ch virtual
// device (nobody hears it), and hear the meeting by recording BlackHole's
// input side. Max hears exactly what a person in his seat would hear, and
// his own voice is never in it (Meet doesn't play your own mic back).
//
// Must be registered BEFORE the in-page voice injector (which replaces
// getUserMedia) and before audioCapture (which creates an AudioContext).

import type { Page } from 'playwright'

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types */
function installMacRouting(): void {
    const w = window as any
    if (w.__maxRoute) return
    if (location.hostname !== 'meet.google.com') return
    const st: any = {
        installed: true,
        labelsVisible: null,
        outFound: false,
        inFound: false,
        ctxSeen: 0,
        ctxRouted: 0,
        elSeen: 0,
        elRouted: 0,
        loopback: 'pending',
        loopbackLabel: null,
        errors: [],
    }
    w.__maxRoute = st
    w.__maxLoopbackCapture = true
    const md = navigator.mediaDevices
    const origGUM = md && md.getUserMedia ? md.getUserMedia.bind(md) : null
    const origCtxSetSink =
        (w.AudioContext && w.AudioContext.prototype.setSinkId) || null
    const origElSetSink = (HTMLMediaElement.prototype as any).setSinkId || null
    const origPlay = HTMLMediaElement.prototype.play
    const err = (m: string): void => {
        if (st.errors.length < 20) st.errors.push(m)
    }

    let ids: Promise<{ out: string | null; inp: string | null }> | null = null
    st.enumerations = []
    const getIds = (fresh = false) => {
        if (fresh) ids = null
        if (!ids) {
            ids = md
                .enumerateDevices()
                .then((devs: MediaDeviceInfo[]) => {
                    st.labelsVisible = devs.some((d) => !!d.label)
                    if (st.enumerations.length < 6) {
                        st.enumerations.push({
                            at: Math.round(performance.now()),
                            blackhole: devs
                                .filter((d) => /blackhole/i.test(d.label))
                                .map((d) => d.kind + ':' + d.deviceId.slice(0, 8)),
                        })
                    }
                    const out = devs.find(
                        (d) => d.kind === 'audiooutput' && /blackhole/i.test(d.label),
                    )
                    const inp = devs.find(
                        (d) => d.kind === 'audioinput' && /blackhole/i.test(d.label),
                    )
                    st.outFound = !!out
                    st.inFound = !!inp
                    return {
                        out: out ? out.deviceId : null,
                        inp: inp ? inp.deviceId : null,
                    }
                })
                .catch((e: Error) => {
                    err('enumerate: ' + e.message)
                    return { out: null, inp: null }
                })
        }
        return ids
    }
    // On "not found", re-list devices and retry: IDs listed at page start
    // may not be valid yet when used (2026-10-22 hypothesis under test).
    const withRetry = async (
        what: string,
        fn: (out: string) => Promise<void>,
    ): Promise<boolean> => {
        for (let attempt = 0; attempt < 4; attempt++) {
            const { out } = await getIds(attempt > 0)
            if (!out) return false
            try {
                await fn(out)
                if (attempt > 0) st.retrySuccesses = (st.retrySuccesses || 0) + 1
                return true
            } catch (e) {
                err(what + ' try ' + attempt + ': ' + (e as Error).name + ' ' + (e as Error).message.slice(0, 60))
                await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
            }
        }
        return false
    }
    const routeCtx = async (ctx: any): Promise<void> => {
        if (!origCtxSetSink) return
        if (await withRetry('ctx', (out) => origCtxSetSink.call(ctx, out))) st.ctxRouted++
    }
    const routeEl = async (el: any): Promise<void> => {
        if (!origElSetSink) return
        if (await withRetry('el', (out) => origElSetSink.call(el, out))) st.elRouted++
    }

    // Every AudioContext (Meet's, and ours) plays into BlackHole.
    if (w.AudioContext) {
        const Orig = w.AudioContext
        const Routed = new Proxy(Orig, {
            construct(target: any, args: any[], newTarget: Function): object {
                const c = Reflect.construct(target, args, newTarget) as object
                st.ctxSeen++
                void routeCtx(c)
                return c
            },
        })
        w.AudioContext = Routed
        w.webkitAudioContext = Routed
        if (origCtxSetSink) {
            Orig.prototype.setSinkId = function (this: any) {
                return routeCtx(this)
            }
        }
    }
    // Same for any <audio>/<video> element, in the DOM or detached.
    const seen = new WeakSet<object>()
    HTMLMediaElement.prototype.play = function (this: any, ...a: any[]) {
        if (!seen.has(this)) {
            seen.add(this)
            st.elSeen++
        }
        return routeEl(this).then(() => origPlay.apply(this, a as []))
    }
    if (origElSetSink) {
        ;(HTMLMediaElement.prototype as any).setSinkId = function (this: any) {
            return routeEl(this)
        }
    }

    // Hear the meeting: record BlackHole's input side, unprocessed.
    const openLoopback = async (): Promise<void> => {
        if (!origGUM) {
            st.loopback = 'no getUserMedia'
            return
        }
        let s: MediaStream | null = null
        for (let attempt = 0; attempt < 4 && !s; attempt++) {
            const { inp } = await getIds(attempt > 0)
            if (!inp) {
                st.loopback = 'no BlackHole input found'
                return
            }
            try {
                s = await origGUM({
                    audio: {
                        deviceId: { exact: inp },
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                    },
                })
            } catch (e) {
                const x = e as any
                err('loopback try ' + attempt + ': ' + x.name + ' constraint=' + (x.constraint || '') + ' ' + (x.message || ''))
                await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
            }
        }
        if (!s) {
            st.loopback = 'error'
            return
        }
        try {
            const t = s.getAudioTracks()[0]
            st.loopbackLabel = t ? t.label : null
            for (let i = 0; i < 100 && typeof w.__maxConnectTrack !== 'function'; i++) {
                await new Promise((r) => setTimeout(r, 100))
            }
            if (typeof w.__maxConnectTrack !== 'function') {
                st.loopback = 'capture script not ready'
                return
            }
            w.__maxConnectTrack(t, { loopback: true })
            st.loopback = 'connected'
        } catch (e) {
            st.loopback = 'error'
            err('loopback: ' + (e as Error).message)
        }
    }
    void openLoopback()
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function installMacAudioRouting(page: Page): Promise<void> {
    await page.addInitScript(installMacRouting)
}
