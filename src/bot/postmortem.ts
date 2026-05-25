// src/bot/postmortem.ts
//
// In-memory ring buffer of subprocess-death events. Exposed via
// /diag/postmortem so the next session (or a debugger) can see what
// killed the previous bot. Singleton because max-bot is single-tenant.

export type PostmortemKind = 'ffmpeg' | 'chromium' | 'playwright_page' | 'bridge_ws'

export interface PostmortemEvent {
    kind: PostmortemKind
    pid: number | null
    exitCode: number | null
    signal: string | null
    stderrTail: string
    timestamp: number
}

const MAX_ENTRIES = 20
const ring: PostmortemEvent[] = []

export function recordPostmortem(
    event: Omit<PostmortemEvent, 'timestamp'>,
): void {
    ring.push({ ...event, timestamp: Date.now() })
    if (ring.length > MAX_ENTRIES) {
        ring.splice(0, ring.length - MAX_ENTRIES)
    }
}

export function getLatestPostmortem(): PostmortemEvent | null {
    if (ring.length === 0) return null
    return ring[ring.length - 1]
}

export function getAllPostmortems(): PostmortemEvent[] {
    // Newest first.
    return [...ring].reverse()
}

/** Test-only escape hatch. */
export function _clearPostmortems(): void {
    ring.length = 0
}
