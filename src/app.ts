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
import { MaxBrainBridge } from './bot/maxBrainBridge'
import {
    getSession,
    hasActiveSession,
    registerSession,
    removeSession,
    withTimeout,
} from './bot/sessions'
import {
    getAllPostmortems,
    getLatestPostmortem,
    recordPostmortem,
} from './bot/postmortem'
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
        const checks = {
            xvfb: false,
            pulse: false,
        }
        try {
            execSync('xdpyinfo -display :99', {
                timeout: 1500,
                stdio: ['ignore', 'ignore', 'ignore'],
            })
            checks.xvfb = true
        } catch {
            checks.xvfb = false
        }
        try {
            execSync('pactl info', {
                timeout: 1500,
                stdio: ['ignore', 'ignore', 'ignore'],
            })
            checks.pulse = true
        } catch {
            checks.pulse = false
        }
        const healthy = checks.xvfb && checks.pulse
        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'ok' : 'degraded',
            service: 'max-bot',
            version: VERSION,
            checks,
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
            // Critical routing diagnostics: who is writing to / reading from
            // each pulse sink/source. This tells us if Chrome's outgoing mic
            // is actually consuming virtual_mic.
            sink_inputs: tryExec('pactl list sink-inputs 2>&1 | head -80 || echo NONE'),
            source_outputs: tryExec('pactl list source-outputs 2>&1 | head -80 || echo NONE'),
            default_source: tryExec('pactl get-default-source 2>&1 || echo unknown'),
            default_sink: tryExec('pactl get-default-sink 2>&1 || echo unknown'),
            sources_full: tryExec('pactl list sources 2>&1 | head -120 || echo NONE'),
            ffmpeg_processes: tryExec('ps -eo pid,etime,args | grep -i ffmpeg | grep -v grep || echo NONE'),
            chromium_processes: tryExec('ps -eo pid,etime,args | grep -iE "chrom" | grep -v grep | head -5 || echo NONE'),
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
            let resolvedBotId: string | null = null
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
                onPageDeath: (event) => {
                    // eslint-disable-next-line no-console
                    console.warn(
                        `[page death] bot=${resolvedBotId ?? '?'} reason=${event.reason}`,
                    )
                    recordPostmortem({
                        kind: 'playwright_page',
                        pid: null,
                        exitCode: null,
                        signal: event.reason,
                        stderrTail: `Playwright page emitted ${event.reason}`,
                    })
                    // Auto-cleanup: trigger session.close() asynchronously.
                    const dead = resolvedBotId
                        ? getSession(resolvedBotId)
                        : undefined
                    if (dead) {
                        dead.close().catch(() => {})
                        removeSession(resolvedBotId!)
                    }
                },
            })
            resolvedBotId = bot_id
            // Open the outbound WebSocket to max-brain. When
            // MAX_BRAIN_WS_URL is unset (local dev), bridge harmlessly
            // attempts ws://localhost:0/${bot_id} and stays disconnected;
            // does not affect the rest of the /join flow.
            const maxBrainWsUrl =
                process.env.MAX_BRAIN_WS_URL ?? 'ws://localhost:0'
            const maxBrainBridge = new MaxBrainBridge({
                wsUrl: maxBrainWsUrl,
                botId: bot_id,
                audioStream,
                audioInject,
            })
            registerSession({
                bot_id,
                meeting_url,
                bot_name,
                startedAt: new Date(),
                audioStream,
                audioInject,
                maxBrainBridge,
                page,
                close: async () => {
                    maxBrainBridge.stop()
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

    // Surfaces what page the bot's Chromium is actually on. Critical
    // for debugging joinMeet regressions (bot stuck on pre-join, sign-in,
    // captcha, etc.). Returns URL, title, and a snippet of body text.
    app.get('/diag/page/:bot_id', async (req: Request, res: Response) => {
        const { bot_id } = req.params
        const session = getSession(bot_id)
        if (!session) {
            res.status(404).json({
                error: `no active session for bot_id=${bot_id}`,
            })
            return
        }
        try {
            const result = await session.page.evaluate(() => {
                const text = (document.body?.innerText || '').slice(0, 2500)
                // Collect a few visible button texts so we can see what
                // join CTAs (if any) the page is offering.
                const buttons: string[] = []
                document.querySelectorAll('button, [role="button"]').forEach(
                    (b) => {
                        const t = (b as HTMLElement).innerText?.trim()
                        if (t && t.length > 0 && t.length < 80) buttons.push(t)
                    },
                )
                return {
                    url: window.location.href,
                    title: document.title,
                    readyState: document.readyState,
                    bodyTextSnippet: text,
                    visibleButtons: buttons.slice(0, 30),
                }
            })
            res.status(200).json({ bot_id, ...result })
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

    // MaxBrainBridge diagnostics — bytes in/out, connection state.
    // Critical for diagnosing whether max-brain is actually sending
    // TTS audio bytes back over the WS bridge.
    app.get('/diag/bridge/:bot_id', (req: Request, res: Response) => {
        const session = getSession(req.params.bot_id)
        if (!session) {
            res.status(404).json({
                error: `no active session for bot_id=${req.params.bot_id}`,
            })
            return
        }
        const b = session.maxBrainBridge
        res.status(200).json({
            bot_id: req.params.bot_id,
            connected: b.isConnected(),
            disconnectedSince: b.disconnectedSince,
            heartbeatReconnects: b.heartbeatReconnects,
            bytesReceivedFromBrain: b.bytesReceivedFromBrain,
            messagesReceivedFromBrain: b.messagesReceivedFromBrain,
            bytesSentToBrain: b.bytesSentToBrain,
            chunksSentToBrain: b.chunksSentToBrain,
            lastOpenAt: b.lastOpenAt,
            lastCloseAt: b.lastCloseAt,
            lastCloseCode: b.lastCloseCode,
            lastMessageAt: b.lastMessageAt,
            lastConnectError: b.lastConnectError,
        })
    })


    // Exposes the ring buffer of subprocess-death events. Use this when a
    // session feels broken — `latest` shows what just died.
    app.get('/diag/postmortem', (_req: Request, res: Response) => {
        res.status(200).json({
            latest: getLatestPostmortem(),
            all: getAllPostmortems(),
        })
    })

    // Debug-only: force-kill the current session's ffmpeg subprocess so
    // F.21 live test can verify postmortem capture works and Railway
    // healthcheck restart kicks in. NOT auth-gated (max-bot is single-tenant
    // behind Railway).
    app.post('/diag/kill/ffmpeg/:bot_id', (req: Request, res: Response) => {
        const session = getSession(req.params.bot_id)
        if (!session) {
            res.status(404).json({
                error: `no active session for bot_id=${req.params.bot_id}`,
            })
            return
        }
        const pid = session.audioInject.child?.pid ?? null
        try {
            session.audioInject.child?.kill('SIGKILL')
        } catch (err) {
            res.status(500).json({
                error: err instanceof Error ? err.message : String(err),
            })
            return
        }
        res.status(200).json({ ok: true, killed_pid: pid })
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
        // Wrap close() in a 15s timeout. If Playwright/Chromium hangs,
        // we still respond cleanly and let the next /join replace state.
        const result = await withTimeout(
            session.close(),
            15000,
            `leave/${bot_id}`,
        )
        removeSession(bot_id)
        if (result.timedOut) {
            recordPostmortem({
                kind: 'playwright_page',
                pid: null,
                exitCode: null,
                signal: 'LEAVE_TIMEOUT',
                stderrTail: `/leave/${bot_id} cleanup exceeded 15s — session removed from registry, child processes may be lingering`,
            })
            // eslint-disable-next-line no-console
            console.warn(`/leave/${bot_id}: close() exceeded 15s, forcing`)
        }
        res.status(200).json({
            ok: true,
            bot_id,
            forced: result.timedOut,
        })
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
