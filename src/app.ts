// Top-level long-running HTTP service entrypoint for the self-hosted max-bot.
//
// Milestone A: just /health. Later milestones will add /join, /leave,
// and a WebSocket /ws/{bot_id} on this same Express app.
//
// Note: `src/server.ts` already exists in this repo from the upstream
// meet-teams-bot codebase — that's the in-recording control plane invoked
// from main.ts. We deliberately do NOT touch it. This file is a separate,
// new entrypoint.

import express, { Application, Request, Response } from 'express'

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
