#!/usr/bin/env node
// Stream a WAV file's PCM into a bot's /ws_in/:bot_id at real-time pace.
//
// Usage:
//   node scripts/play-audio-to-bot.js <ws_in url> <in.wav> [chunk_ms=100]
//
// The WAV must be 16-bit mono 16 kHz. To convert any source file:
//   ffmpeg -i input.mp3 -ar 16000 -ac 1 -sample_fmt s16 out.wav

const fs = require('fs')
const WebSocket = require('ws')

const [, , url, wavPath, chunkMsArg] = process.argv
if (!url || !wavPath) {
    console.error(
        'usage: play-audio-to-bot.js <ws_in url> <in.wav> [chunk_ms=100]',
    )
    process.exit(2)
}
const chunkMs = Number(chunkMsArg) || 100

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const chunkBytes = (SAMPLE_RATE * BYTES_PER_SAMPLE * chunkMs) / 1000

const wav = fs.readFileSync(wavPath)
// Naive WAV header skip — assumes standard 44-byte PCM header.
const data = wav.slice(44)
const durationSec = data.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)
console.log(
    `loaded ${data.length} bytes (${durationSec.toFixed(1)}s @ 16kHz mono Int16)`,
)

const ws = new WebSocket(url)

ws.on('open', () => {
    console.log('ws open, streaming...')
    let offset = 0
    const startedAt = Date.now()
    const tick = () => {
        if (offset >= data.length) {
            const elapsed = (Date.now() - startedAt) / 1000
            console.log(`streamed ${data.length} bytes in ${elapsed.toFixed(1)}s`)
            // Give the receive side a moment to drain before closing.
            setTimeout(() => ws.close(), 500)
            return
        }
        const end = Math.min(offset + chunkBytes, data.length)
        const chunk = data.slice(offset, end)
        ws.send(chunk, { binary: true })
        offset = end
        setTimeout(tick, chunkMs)
    }
    tick()
})

ws.on('close', (code) => {
    console.log(`ws closed (code=${code})`)
})

ws.on('error', (e) => {
    console.error('ws error:', e.message)
    process.exit(1)
})
