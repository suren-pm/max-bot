// Top-level long-running HTTP+WS service entrypoint for the self-hosted max-bot.
//
// Milestone A: /health
// Milestone B: + POST /join, POST /leave/:bot_id, GET /diag
// Milestone C: + WebSocket /ws/:bot_id, per-bot AudioStream
//
// Note: `src/server.ts` already exists in this repo from upstream
// meet-teams-bot — that's the in-recording control plane invoked from
// main.ts. We deliberately do NOT touch it. This file is a separate,
// new entrypoint.

import { execSync } from 'child_process'
import express, { Application, Request, Response } from 'express'
import { createServer as createHttpServer, Server as HttpServer } from 'http'
import { WebSocketServer } from 'ws'

import { attachAudioCapture } from './bot/audioCapture'
import { AudioInject } from './bot/audioInject'
import { AudioStream } from './bot/audioStream'
import { joinMeet } from './bot/joinMeet'
import {
    getSession,
    hasActiveSession,
    registerSession,
    removeSession,
} from './bot/sessions'
import { attachWebSocketServer } from './bot/wsServer'

const VERSION = '0.1.0'

// The output sample rate of every captured audio stream. Matches what
// MBaaS sends max-brain today; Milestone E becomes a one-line URL swap.
const OUTPUT_SAMPLE_RATE = 16000

// Source sample rate from Chrome's WebRTC track — virtually always 48kHz.
// The AudioStream resampler tolerates any source rate; we set 48k as a
// reasonable initial estimate and let the actual frame.sampleRate flow
// through. (The Float32 frames go in, resampling is applied per push.)
const SOURCE_SAMPLE_RATE_HINT = 48000

export interface AppWithServer {
    app: Application
    server: HttpServer
    wss: WebSocketServer
}

export function createServer(): Application {
    const { app } = createServerWithWs()
    return app
}

export function createServerWithWs(): AppWithServer {
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
    // Playwright/Xvfb/PulseAudio issues without needing Railway log access.
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
            active_ws_clients: wss?.clients?.size ?? 0,
        })
    })

    // Deep PulseAudio diagnostic — used to root-cause why pulseaudio
    // refuses to start in our container. Front-loaded for Milestone D.
    app.get('/diag/pulse', (_req: Request, res: Response) => {
        const tryExec = (cmd: string): string => {
            try {
                return execSync(cmd, {
                    timeout: 3000,
                    stdio: ['ignore', 'pipe', 'pipe'],
                })
                    .toString()
                    .trim()
            } catch (e) {
                return `ERROR: ${e instanceof Error ? e.message : String(e)}`
            }
        }
        res.status(200).json({
            env: {
                PULSE_RUNTIME_PATH: process.env.PULSE_RUNTIME_PATH ?? null,
                XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? null,
                DBUS_SESSION_BUS_ADDRESS:
                    process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
                USER: process.env.USER ?? null,
                HOME: process.env.HOME ?? null,
            },
            whoami: tryExec('whoami'),
            pulse_processes: tryExec('pgrep -a pulseaudio || echo NONE'),
            pulse_check: tryExec(
                'pulseaudio --check 2>&1; echo "exitcode=$?"',
            ),
            runtime_dir_listing: tryExec(
                'ls -la /tmp/pulse 2>&1 || echo MISSING',
            ),
            dbus_socket: tryExec(
                'ls -la /run/dbus/system_bus_socket 2>&1 || echo MISSING',
            ),
            dbus_processes: tryExec(
                'pgrep -a dbus-daemon || echo NONE',
            ),
            pulse_log_search: tryExec(
                "find /tmp /root /var/log -name 'pulse*.log' 2>/dev/null | head -5 || echo NONE",
            ),
            machine_id: tryExec('cat /etc/machine-id 2>&1 || cat /var/lib/dbus/machine-id 2>&1'),
            // Try to start pulseaudio in foreground for 1 second to capture
            // its actual error message.
            try_start_short: tryExec(
                'timeout 2 pulseaudio --start --log-target=stderr --log-level=info -vvvv 2>&1 | head -30',
            ),
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
            const audioStream = new AudioStream({
                srcSampleRate: SOURCE_SAMPLE_RATE_HINT,
                dstSampleRate: OUTPUT_SAMPLE_RATE,
            })
            // Spawn the per-bot ffmpeg subprocess that pumps incoming
            // /ws_in/:bot_id frames into the PulseAudio virtual_mic source.
            const audioInject = new AudioInject({
                sampleRate: OUTPUT_SAMPLE_RATE,
            })
            // Set up audio capture inside joinMeet's onPageReady hook so
            // the RTCPeerConnection wrapper is in place BEFORE Meet's
            // JavaScript starts running. Without this, our wrap fires
            // too late and the audio tracks bypass our mixer.
            const { bot_id, page, close } = await joinMeet({
                meeting_url,
                bot_name,
                onPageReady: async (page) => {
                    try {
                        await attachAudioCapture(page, audioStream)
                    } catch (err) {
                        // eslint-disable-next-line no-console
                        console.warn(
                            'attachAudioCapture failed (continuing without audio):',
                            err instanceof Error ? err.message : String(err),
                        )
                    }
                },
            })
            registerSession({
                bot_id,
                meeting_url,
                bot_name,
                startedAt: new Date(),
                audioStream,
                audioInject,
                page,
                close: async () => {
                    audioStream.stop()
                    audioInject.stop()
                    await close()
                },
            })
            res.status(200).json({ bot_id })
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            res.status(500).json({ error: message })
        }
    })

    // Browser-side audio diagnostics. Reads the window.__maxBotAudio
    // state object the audioCapture inject script maintains, so we can
    // tell which step of the capture pipeline is failing on a live bot.
    app.get('/diag/audio/:bot_id', async (req: Request, res: Response) => {
        const { bot_id } = req.params
        const session = getSession(bot_id)
        if (!session) {
            res.status(404).json({
                error: `no active session for bot_id=${bot_id}`,
            })
            return
        }
        try {
            const state = await session.page.evaluate(() => {
                return (window as unknown as { __maxBotAudio?: unknown })
                    .__maxBotAudio ?? null
            })
            res.status(200).json({ bot_id, browser_state: state })
        } catch (err) {
            res.status(500).json({
                error: err instanceof Error ? err.message : String(err),
            })
        }
    })

    // Audio-injection diagnostics — reports ffmpeg subprocess state
    // (pid, killed) for the bot's AudioInject. Useful to confirm the
    // subprocess is alive and accepting bytes.
    app.get('/diag/inject/:bot_id', (req: Request, res: Response) => {
        const session = getSession(req.params.bot_id)
        if (!session) {
            res.status(404).json({
                error: `no active session for bot_id=${req.params.bot_id}`,
            })
            return
        }
        const child = session.audioInject.child
        res.status(200).json({
            bot_id: req.params.bot_id,
            ffmpeg_pid: child?.pid ?? null,
            ffmpeg_killed: child?.killed ?? null,
            ffmpeg_exit_code: child?.exitCode ?? null,
            ffmpeg_stderr_tail: session.audioInject.stderrTail.join(''),
        })
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
            // Log but still treat as successful — goal is to forget the bot.
            const message = err instanceof Error ? err.message : String(err)
            // eslint-disable-next-line no-console
            console.warn(`close() threw during /leave/${bot_id}: ${message}`)
        }
        removeSession(bot_id)
        res.status(200).json({ ok: true, bot_id })
    })

    // Wrap in an http.Server and attach the WebSocket upgrade handler.
    const httpServer = createHttpServer(app)
    const wss = attachWebSocketServer(httpServer)

    return { app, server: httpServer, wss }
}

// Allow running directly: `node build/src/app.js` on Railway.
// PORT is provided by Railway; default 8080 for local dev.
if (require.main === module) {
    const port = Number(process.env.PORT) || 8080
    const { server } = createServerWithWs()
    server.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`max-bot listening on :${port}`)
    })
}
