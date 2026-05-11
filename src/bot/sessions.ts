// Tiny in-memory registry of currently-active join sessions.
//
// Milestone B scope is single-bot, but the API is shaped as a Map so
// later milestones can lift the "one active bot" restriction without
// rewriting callers.

export interface JoinSession {
    bot_id: string
    meeting_url: string
    bot_name: string
    startedAt: Date
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

/** Test-only escape hatch — clears all sessions. */
export function _clearAllSessions(): void {
    sessions.clear()
}
