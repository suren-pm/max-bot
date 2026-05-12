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

const WS_PATH_OUT_RE = /^\/ws\/([A-Za-z0-9_-]+)\/?$/
const WS_PATH_IN_RE = /^\/ws_in\/([A-Za-z0-9_-]+)\/?$/

export function attachWebSocketServer(server: HttpServer): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req: IncomingMessage, socket, head) => {
        const url = req.url ?? ''

        // /ws/:bot_id — outgoing (meeting audio → client)
        const outMatch = WS_PATH_OUT_RE.exec(url)
        if (outMatch) {
            const bot_id = outMatch[1]
            const session = getSession(bot_id)
            if (!session) {
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
            return
        }

        // /ws_in/:bot_id — incoming (client audio → bot's mic)
        const inMatch = WS_PATH_IN_RE.exec(url)
        if (inMatch) {
            const bot_id = inMatch[1]
            const session = getSession(bot_id)
            if (!session) {
                wss.handleUpgrade(req, socket, head, (ws) => {
                    ws.close(1008, 'unknown bot_id')
                })
                return
            }
            wss.handleUpgrade(req, socket, head, (ws) => {
                ws.on('message', (m: unknown) => {
                    if (m instanceof Buffer) {
                        session.audioInject.pushInt16Buffer(m)
                    }
                })
            })
            return
        }

        // No match — destroy socket.
        socket.destroy()
    })

    return wss
}
