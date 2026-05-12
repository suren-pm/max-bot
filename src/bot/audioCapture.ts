// Inject a Web Audio mixer into the Meet page and route every captured
// chunk back to a local AudioStream.
//
// The browser-side script is adapted from upstream
// src/meeting/shared/audio-capture.ts:36-340 — proven pattern that:
//   1. Wraps RTCPeerConnection so every WebRTC track is observed
//   2. Connects each audio track to a single MediaStreamDestination (mixer)
//   3. Reads the mixer output via MediaStreamTrackProcessor (modern API)
//   4. Mixes stereo→mono and sends Float32 chunks back via window callback
//
// We deliberately do NOT import from src/meeting/* — that code is tied to
// the GLOBAL singleton and Streaming.instance. This module takes an
// AudioStream parameter so callers wire the sink themselves.

import type { Page } from 'playwright'

import { AudioStream } from './audioStream'

const CALLBACK_NAME = 'maxBotPushAudioFrame'
const STOP_FUNCTION_NAME = '__maxBotAudioStop'
const LOG_PREFIX = '[MaxBotAudio]'

interface BrowserAudioChunk {
    audioData: number[]
    sampleRate: number
    timestamp: number
    numberOfFrames: number
}

// Browser-side capture script. Adapted from upstream
// src/meeting/shared/audio-capture.ts:39-340. Differences:
//   - Hardcoded callback name maxBotPushAudioFrame
//   - Stripped Teams-specific periodic-scanning branch
//   - Strings inlined (no template-variable injection)
//   - No upstream Streaming.instance reference on the Node side
const BROWSER_SCRIPT = `
(function() {
    // Diagnostic state — read via page.evaluate from Node.
    window.__maxBotAudio = {
        scriptLoaded: false,
        scriptLoadedAt: null,
        audioContextCreated: false,
        rtcWrapped: false,
        rtcWrapError: null,
        trackEventCount: 0,
        tracksConnected: 0,
        mediaStreamTrackProcessorAvailable:
            typeof MediaStreamTrackProcessor !== 'undefined',
        processorStarted: false,
        chunksSent: 0,
        lastError: null,
        callbackAvailable: false,
    };

    try {
        console.log('${LOG_PREFIX} Initializing Web Audio mixer...');
        window.__maxBotAudio.scriptLoaded = true;
        window.__maxBotAudio.scriptLoadedAt = Date.now();
        window.__maxBotAudio.callbackAvailable =
            typeof window.${CALLBACK_NAME} === 'function';

        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        window.__maxBotAudio.audioContextCreated = true;
        const mixerDestination = audioCtx.createMediaStreamDestination();
        const mixedAudioSources = new Map();
        let mixedStreamProcessor = null;
        let chunksSent = 0;
        let abortController = null;
        let processorPromise = null;

        async function startMixedStreamProcessor() {
            if (mixedStreamProcessor) return;
            const mixedTrack = mixerDestination.stream.getAudioTracks()[0];
            if (!mixedTrack) {
                console.error('${LOG_PREFIX} No mixed audio track available');
                return;
            }
            try {
                if (typeof MediaStreamTrackProcessor === 'undefined') {
                    console.error('${LOG_PREFIX} MediaStreamTrackProcessor not available');
                    window.__maxBotAudio.lastError = 'MediaStreamTrackProcessor not available';
                    return;
                }
                const processor = new MediaStreamTrackProcessor({ track: mixedTrack });
                const reader = processor.readable.getReader();
                mixedStreamProcessor = reader;
                window.__maxBotAudio.processorStarted = true;
                abortController = new AbortController();
                const signal = abortController.signal;
                console.log('${LOG_PREFIX} Started Web Audio mixed stream processor');

                const processFrames = async (signal) => {
                    let currentFrame = null;
                    const onAbort = () => {
                        reader.cancel().catch(() => {});
                    };
                    signal.addEventListener('abort', onAbort);

                    try {
                        while (true) {
                            if (signal.aborted) break;
                            const { done, value: frame } = await reader.read();
                            if (done) break;
                            if (signal.aborted) {
                                if (frame) frame.close();
                                break;
                            }
                            if (!frame) continue;
                            currentFrame = frame;
                            try {
                                const numChannels = frame.numberOfChannels;
                                const numSamples = frame.numberOfFrames;
                                const audioData = new Float32Array(numSamples);
                                if (numChannels > 1) {
                                    const channelData = new Float32Array(numSamples);
                                    for (let ch = 0; ch < numChannels; ch++) {
                                        frame.copyTo(channelData, { planeIndex: ch });
                                        for (let i = 0; i < numSamples; i++) {
                                            audioData[i] += channelData[i];
                                        }
                                    }
                                    for (let i = 0; i < numSamples; i++) {
                                        audioData[i] /= numChannels;
                                    }
                                } else {
                                    frame.copyTo(audioData, { planeIndex: 0 });
                                }
                                if (typeof window.${CALLBACK_NAME} === 'function') {
                                    window.${CALLBACK_NAME}({
                                        audioData: Array.from(audioData),
                                        sampleRate: frame.sampleRate,
                                        timestamp: frame.timestamp,
                                        numberOfFrames: numSamples,
                                    });
                                    chunksSent++;
                                    window.__maxBotAudio.chunksSent = chunksSent;
                                    if (chunksSent === 1) {
                                        console.log('${LOG_PREFIX} First chunk sent to Node');
                                    } else if (chunksSent % 100 === 0) {
                                        console.log('${LOG_PREFIX} Sent ' + chunksSent + ' chunks');
                                    }
                                }
                                frame.close();
                                currentFrame = null;
                            } catch (err) {
                                if (currentFrame) {
                                    try { currentFrame.close(); } catch (e) {}
                                    currentFrame = null;
                                }
                            }
                        }
                    } finally {
                        signal.removeEventListener('abort', onAbort);
                        if (currentFrame) {
                            try { currentFrame.close(); } catch (e) {}
                        }
                        try { reader.releaseLock(); } catch (e) {}
                        mixedStreamProcessor = null;
                        console.log('${LOG_PREFIX} Processor cleanup, sent ' + chunksSent + ' total chunks');
                    }
                };
                processorPromise = processFrames(signal);
            } catch (e) {
                console.error('${LOG_PREFIX} Failed to start mixed stream processor:', e);
            }
        }

        async function stopMixedStreamProcessor() {
            if (abortController) {
                abortController.abort();
                if (processorPromise) {
                    try { await processorPromise; } catch (e) {}
                }
                abortController = null;
                processorPromise = null;
            }
        }
        window.${STOP_FUNCTION_NAME} = stopMixedStreamProcessor;

        window.addEventListener('beforeunload', () => stopMixedStreamProcessor());

        function connectTrackToMixer(track) {
            if (mixedAudioSources.has(track.id)) return;
            try {
                if (audioCtx.state === 'suspended') audioCtx.resume();
                const stream = new MediaStream([track]);
                const source = audioCtx.createMediaStreamSource(stream);
                source.connect(mixerDestination);
                mixedAudioSources.set(track.id, source);
                window.__maxBotAudio.tracksConnected = mixedAudioSources.size;
                console.log('${LOG_PREFIX} Connected track ' + track.id + ' (' + mixedAudioSources.size + ' total)');
                if (mixedAudioSources.size === 1) {
                    startMixedStreamProcessor();
                }
                track.onended = () => {
                    source.disconnect();
                    mixedAudioSources.delete(track.id);
                    window.__maxBotAudio.tracksConnected = mixedAudioSources.size;
                };
            } catch (e) {
                console.error('${LOG_PREFIX} Failed to connect track:', e);
                window.__maxBotAudio.lastError = 'connectTrackToMixer: ' + e.message;
            }
        }

        // Wrap RTCPeerConnection so we hook every audio track that arrives.
        try {
            if (typeof window.RTCPeerConnection !== 'undefined') {
                const OriginalPC = window.RTCPeerConnection;
                const WrappedPC = function (...args) {
                    const pc = new OriginalPC(...args);
                    pc.addEventListener('track', (event) => {
                        window.__maxBotAudio.trackEventCount++;
                        if (event.track.kind === 'audio') {
                            console.log('${LOG_PREFIX} Audio track detected:', event.track.id);
                            connectTrackToMixer(event.track);
                        }
                    });
                    return pc;
                };
                // Copy prototype so 'instanceof RTCPeerConnection' still works
                // (Meet may check this internally).
                WrappedPC.prototype = OriginalPC.prototype;
                // Copy static methods (e.g. generateCertificate).
                for (const key of Object.getOwnPropertyNames(OriginalPC)) {
                    if (key === 'prototype' || key === 'length' || key === 'name') continue;
                    try {
                        const desc = Object.getOwnPropertyDescriptor(OriginalPC, key);
                        if (desc) Object.defineProperty(WrappedPC, key, desc);
                    } catch (e) {}
                }
                window.RTCPeerConnection = WrappedPC;
                window.__maxBotAudio.rtcWrapped = true;
            }
        } catch (e) {
            console.error('${LOG_PREFIX} RTCPeerConnection wrap failed:', e);
            window.__maxBotAudio.rtcWrapError = e.message;
        }
    } catch (e) {
        console.error('${LOG_PREFIX} Audio capture init failed:', e);
        if (window.__maxBotAudio) window.__maxBotAudio.lastError = e.message;
    }
})();
`

/**
 * Inject the Web Audio capture script into `page` and route every captured
 * Float32 frame into the given AudioStream. Idempotent — calling twice on
 * the same page is safe (the duplicate `exposeFunction` error is swallowed).
 */
export async function attachAudioCapture(
    page: Page,
    stream: AudioStream,
): Promise<void> {
    try {
        await page.exposeFunction(
            CALLBACK_NAME,
            (chunk: BrowserAudioChunk) => {
                const f32 = Float32Array.from(chunk.audioData)
                stream.pushFloat32(f32)
            },
        )
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!message.includes('has been already registered')) {
            throw err
        }
        // Already registered (idempotent reconnect path) — fine.
    }

    await page.addInitScript(BROWSER_SCRIPT)
}
