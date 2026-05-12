// Attach a WebSocketServer to an existing http.Server. Routes upgrade
// requests on /ws/:bot_id to that bot's AudioStream listeners.
//
// Protocol: binary WS frames, each frame is one chunk of mono 16-bit
// signed PCM at the AudioStream's dstSampleRate (16 kHz in our pipeline).
// This matches what MBaaS sends max-brain today, so Milestone E becomes
// a one-line URL swap on max-brain.

import { IncomingMessage, Server as HttpServer } from 'http'
import { WebSocket, WebSocketServer } from 'ws'

import { getSession } from './sessions'

const WS_PATH_RE = /^\/ws\/([A-Za-z0-9_-]+)\/?$/

export function attachWebSocketServer(server: HttpServer): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req: IncomingMessage, socket, head) => {
        const url = req.url ?? ''
        const match = WS_PATH_RE.exec(url)
        if (!match) {
            socket.destroy()
            return
        }
        const bot_id = match[1]
        const session = getSession(bot_id)
        if (!session) {
            // Accept the upgrade then immediately close with policy-violation
            // code so the client gets a clean signal (rather than a TCP RST).
            wss.handleUpgrade(req, socket, head, (ws) => {
                ws.close(1008, 'unknown bot_id')
            })
            return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            const onChunk = (buf: Buffer): void => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(buf, { binary: true })
                }
            }
            session.audioStream.on('chunk', onChunk)
            const cleanup = (): void => {
                session.audioStream.off('chunk', onChunk)
            }
            ws.on('close', cleanup)
            ws.on('error', cleanup)
        })
    })

    return wss
}
