// Tiny in-memory registry of currently-active join sessions.
//
// Milestone B scope is single-bot, but the API is shaped as a Map so
// later milestones can lift the "one active bot" restriction without
// rewriting callers.
//
// Milestone C adds `audioStream` so /ws/:bot_id can route captured
// audio to the WebSocket client and /leave can stop the stream.

import type { Page } from 'playwright'

import type { AudioInject } from './audioInject'
import type { AudioStream } from './audioStream'
import type { MaxBrainBridge } from './maxBrainBridge'

export interface JoinSession {
    bot_id: string
    meeting_url: string
    bot_name: string
    startedAt: Date
    audioStream: AudioStream
    audioInject: AudioInject
    /** WebSocket bridge to max-brain — opens an outbound connection
     * mimicking MBaaS's client pattern. May be a no-op when
     * MAX_BRAIN_WS_URL env var is unset (local tests / standalone). */
    maxBrainBridge: MaxBrainBridge
    /** Playwright Page handle — exposed so /diag/audio/:bot_id can query
     * browser-side state via page.evaluate. */
    page: Page
    /** Resolves when the underlying Playwright resources are torn down. */
    close: () => Promise<void>
}

const sessions = new Map<string, JoinSession>()

export function registerSession(session: JoinSession): void {
    sessions.set(session.bot_id, session)
}

export function getSession(bot_id: string): JoinSession | undefined {
    return sessions.get(bot_id)
}

export function removeSession(bot_id: string): void {
    sessions.delete(bot_id)
}

export function hasActiveSession(): boolean {
    return sessions.size > 0
}

/** Diagnostic helper: list every registered session. */
export function getAllSessions(): JoinSession[] {
    return Array.from(sessions.values())
}

/** Test-only escape hatch — clears all sessions. */
export function _clearAllSessions(): void {
    sessions.clear()
}

/**
 * Wrap a promise with a timeout. Returns `{timedOut: true}` if the
 * promise didn't settle within `ms` milliseconds — the underlying
 * promise is left running (caller's responsibility to stop bothering).
 * Late rejections are swallowed via a no-op .catch so Node doesn't
 * log unhandledRejection.
 *
 * Used by /leave to ensure the HTTP response never blocks past Railway's
 * gateway timeout, even if Playwright/Chromium cleanup hangs.
 */
export interface WithTimeoutResult<T> {
    timedOut: boolean
    value?: T
    label: string
}

export async function withTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
): Promise<WithTimeoutResult<T>> {
    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<WithTimeoutResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true, label }), ms)
    })
    const innerPromise = p
        .then<WithTimeoutResult<T>>((value) => ({
            timedOut: false,
            value,
            label,
        }))
        .catch<WithTimeoutResult<T>>(() => ({
            // If inner throws, treat as "completed" (not a timeout) so
            // caller doesn't try to force-kill twice.
            timedOut: false,
            label,
        }))
    // Swallow late rejections so they don't become unhandledRejection.
    p.catch(() => {})
    const result = await Promise.race([innerPromise, timeoutPromise])
    if (timer) clearTimeout(timer)
    return result
}
