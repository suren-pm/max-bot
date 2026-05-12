#!/usr/bin/env node
// Tiny capture-to-WAV script for Milestone C acceptance.
//
// Usage:
//   node scripts/save-meeting-audio.js <ws-url> <out.wav> [seconds]
//
// Example:
//   node scripts/save-meeting-audio.js \
//       wss://max-bot-production-7455.up.railway.app/ws/<bot_id> \
//       /tmp/meeting.wav 30

const WebSocket = require('ws')
const fs = require('fs')

const [, , url, outPath, secondsArg] = process.argv
if (!url || !outPath) {
    console.error(
        'usage: save-meeting-audio.js <ws-url> <out.wav> [seconds=30]',
    )
    process.exit(2)
}

const seconds = Number(secondsArg) || 30
const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const expectedBytes = SAMPLE_RATE * BYTES_PER_SAMPLE * seconds

const chunks = []
let received = 0
let firstChunkAt = null

const ws = new WebSocket(url)

ws.on('open', () => {
    console.log(`connected; capturing up to ${seconds}s of audio...`)
})

ws.on('message', (m) => {
    if (firstChunkAt === null) {
        firstChunkAt = Date.now()
        console.log(`first chunk received after ${Date.now() - startedAt} ms`)
    }
    chunks.push(m)
    received += m.length
    if (received >= expectedBytes) {
        console.log(`reached ${expectedBytes} bytes; closing`)
        ws.close()
    }
})

ws.on('close', (code, reason) => {
    if (code !== 1000 && code !== 1005 && chunks.length === 0) {
        console.error(`closed with code ${code}: ${reason}`)
        process.exit(1)
    }
    const data = Buffer.concat(chunks)
    if (data.length === 0) {
        console.error('no audio bytes received')
        process.exit(1)
    }
    // Minimal WAV (PCM 16-bit mono) header.
    const hdr = Buffer.alloc(44)
    hdr.write('RIFF', 0)
    hdr.writeUInt32LE(36 + data.length, 4)
    hdr.write('WAVE', 8)
    hdr.write('fmt ', 12)
    hdr.writeUInt32LE(16, 16)
    hdr.writeUInt16LE(1, 20) // format: PCM
    hdr.writeUInt16LE(1, 22) // channels: mono
    hdr.writeUInt32LE(SAMPLE_RATE, 24)
    hdr.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28) // byte rate
    hdr.writeUInt16LE(BYTES_PER_SAMPLE, 32) // block align
    hdr.writeUInt16LE(16, 34) // bits per sample
    hdr.write('data', 36)
    hdr.writeUInt32LE(data.length, 40)
    fs.writeFileSync(outPath, Buffer.concat([hdr, data]))
    const durationSec = data.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)
    console.log(
        `wrote ${outPath} (${data.length} bytes audio, ${durationSec.toFixed(1)}s)`,
    )
})

ws.on('error', (e) => {
    console.error('ws error:', e.message)
    process.exit(1)
})

const startedAt = Date.now()
// Hard cap in case the server stops sending mid-capture.
setTimeout(() => {
    console.error(
        `timed out waiting for ${expectedBytes} bytes; got ${received}`,
    )
    ws.close()
}, (seconds + 5) * 1000)
