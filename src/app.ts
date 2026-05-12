// Top-level long-running HTTP service entrypoint for the self-hosted max-bot.
//
// Milestone A: /health
// Milestone B: + POST /join, POST /leave/:bot_id
// Later milestones will add WebSocket /ws/{bot_id} for audio.
//
// Note: `src/server.ts` already exists in this repo from upstream
// meet-teams-bot — that's the in-recording control plane invoked
// from main.ts. We deliberately do NOT touch it. This file is a
// separate, new entrypoint.

import { execSync } from 'child_process'
import express, { Application, Request, Response } from 'express'

import { joinMeet } from './bot/joinMeet'
import {
    getSession,
    hasActiveSession,
    registerSession,
    removeSession,
} from './bot/sessions'

const VERSION = '0.1.0'

export function createServer(): Application {
    const app = express()
    app.use(express.json())

    app.get('/health', (_req: Request, res: Response) => {
        res.status(200).json({
            status: 'ok',
            service: 'max-bot',
            version: VERSION,
        })
    })

    // Diagnostic endpoint — reports container state useful for debugging
    // Playwright/Xvfb issues without needing Railway log access.
    app.get('/diag', (_req: Request, res: Response) => {
        const tryExec = (cmd: string): string => {
            try {
                return execSync(cmd, {
                    timeout: 2000,
                    stdio: ['ignore', 'pipe', 'pipe'],
                })
                    .toString()
                    .trim()
            } catch (e) {
                return `ERROR: ${e instanceof Error ? e.message : String(e)}`
            }
        }
        res.status(200).json({
            service: 'max-bot',
            version: VERSION,
            env: {
                DISPLAY: process.env.DISPLAY ?? null,
                PULSE_RUNTIME_PATH: process.env.PULSE_RUNTIME_PATH ?? null,
                XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? null,
                NODE_ENV: process.env.NODE_ENV ?? null,
                SERVERLESS: process.env.SERVERLESS ?? null,
            },
            xvfb_process: tryExec("pgrep -a Xvfb || echo 'NOT-RUNNING'"),
            xdpyinfo_display99: tryExec(
                'xdpyinfo -display :99 2>&1 | head -3 || echo NO-XDPYINFO',
            ),
            pulse_info: tryExec('pactl info 2>&1 | head -5 || echo NO-PACTL'),
            pulse_sources: tryExec(
                'pactl list sources short 2>&1 | head -5 || echo NO-SOURCES',
            ),
            startsh_present: tryExec("ls -la /start.sh 2>&1 || echo 'NO'"),
        })
    })

    app.post('/join', async (req: Request, res: Response) => {
        const { meeting_url, bot_name } = req.body ?? {}

        if (typeof meeting_url !== 'string' || meeting_url.length === 0) {
            res.status(400).json({
                error: 'meeting_url is required and must be a non-empty string',
            })
            return
        }
        if (typeof bot_name !== 'string' || bot_name.length === 0) {
            res.status(400).json({
                error: 'bot_name is required and must be a non-empty string',
            })
            return
        }
        if (hasActiveSession()) {
            res.status(409).json({
                error: 'max-bot is already in a meeting; only one bot at a time is supported in v1',
            })
            return
        }

        try {
            const { bot_id, close } = await joinMeet({
                meeting_url,
                bot_name,
            })
            registerSession({
                bot_id,
                meeting_url,
                bot_name,
                startedAt: new Date(),
                close,
            })
            res.status(200).json({ bot_id })
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            res.status(500).json({ error: message })
        }
    })

    app.post('/leave/:bot_id', async (req: Request, res: Response) => {
        const { bot_id } = req.params
        const session = getSession(bot_id)
        if (!session) {
            res.status(404).json({
                error: `no active session for bot_id=${bot_id}`,
            })
            return
        }
        try {
            await session.close()
        } catch (err) {
            // Log but still treat as successful — the goal is to forget the bot.
            const message = err instanceof Error ? err.message : String(err)
            // eslint-disable-next-line no-console
            console.warn(`close() threw during /leave/${bot_id}: ${message}`)
        }
        removeSession(bot_id)
        res.status(200).json({ ok: true, bot_id })
    })

    return app
}

// Allow running directly: `node build/src/app.js` on Railway.
// PORT is provided by Railway; default 8080 for local dev.
if (require.main === module) {
    const port = Number(process.env.PORT) || 8080
    const app = createServer()
    app.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`max-bot listening on :${port}`)
    })
}
