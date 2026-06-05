// Audio-reactive analysis: decode the loaded media's audio track once into a
// per-time RMS envelope, then sample it as a deterministic function of timeline
// time. Determinism is the whole point — the value depends only on timeline
// time (+ the precomputed envelope), never wall-clock or playback state, so an
// audio-driven param renders identically in preview and export.
//
// The envelope is computed here (pure); decoding uses Web Audio (browser/Tauri).
// The audio-level node reads getAudioLevel() at the current render time.

const LISTENERS = new Set();

let currentEnvelope = null;     // Float32Array, normalized to 0..1 (peak = 1)
let currentBucketsPerSecond = 60;

// RMS amplitude per time bucket, normalized so the loudest bucket is 1. Pure.
export function computeRmsEnvelope(channelData, sampleRate, bucketsPerSecond = 60) {
  if (!channelData?.length || !(sampleRate > 0)) return new Float32Array(0);
  const bps = Math.max(1, Math.round(bucketsPerSecond));
  const samplesPerBucket = Math.max(1, Math.round(sampleRate / bps));
  const bucketCount = Math.ceil(channelData.length / samplesPerBucket);
  const envelope = new Float32Array(bucketCount);
  let peak = 0;
  for (let b = 0; b < bucketCount; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(channelData.length, start + samplesPerBucket);
    let sumSquares = 0;
    for (let i = start; i < end; i++) sumSquares += channelData[i] * channelData[i];
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
    envelope[b] = rms;
    if (rms > peak) peak = rms;
  }
  if (peak > 0) for (let b = 0; b < bucketCount; b++) envelope[b] /= peak;
  return envelope;
}

// Sample an envelope at `timeSeconds` with linear interpolation between buckets.
// Pure; clamps to the envelope's ends. Returns 0 for an empty envelope.
export function sampleEnvelope(envelope, bucketsPerSecond, timeSeconds) {
  if (!envelope?.length) return 0;
  const bps = Math.max(1, bucketsPerSecond);
  const pos = Math.max(0, Number(timeSeconds) || 0) * bps;
  const i = Math.floor(pos);
  if (i >= envelope.length - 1) return envelope[envelope.length - 1];
  const frac = pos - i;
  return envelope[i] * (1 - frac) + envelope[i + 1] * frac;
}

// Mix an AudioBuffer down to mono and compute its envelope. Pure given a buffer.
export function analyzeAudioBuffer(audioBuffer, bucketsPerSecond = 60) {
  if (!audioBuffer || audioBuffer.length === 0) return new Float32Array(0);
  const ch0 = audioBuffer.getChannelData(0);
  if (audioBuffer.numberOfChannels > 1) {
    const ch1 = audioBuffer.getChannelData(1);
    const mixed = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) mixed[i] = (ch0[i] + ch1[i]) * 0.5;
    return computeRmsEnvelope(mixed, audioBuffer.sampleRate, bucketsPerSecond);
  }
  return computeRmsEnvelope(ch0, audioBuffer.sampleRate, bucketsPerSecond);
}

// ---- registry (the render reads this; the loader writes it) ----

export function setAudioEnvelope(envelope, bucketsPerSecond) {
  currentEnvelope = envelope && envelope.length ? envelope : null;
  currentBucketsPerSecond = Math.max(1, bucketsPerSecond || 60);
  notify();
}

export function clearAudioEnvelope() {
  if (!currentEnvelope) return;
  currentEnvelope = null;
  notify();
}

export function hasAudioEnvelope() {
  return Boolean(currentEnvelope);
}

// Audio level at `timeSeconds`, scaled by gain and clamped to 0..gain. Pure
// function of timeline time + the stored envelope → preview/export parity.
export function getAudioLevel(timeSeconds, options = {}) {
  if (!currentEnvelope) return 0;
  const gain = Number.isFinite(Number(options.gain)) ? Number(options.gain) : 1;
  return sampleEnvelope(currentEnvelope, currentBucketsPerSecond, timeSeconds) * gain;
}

// Decode an audio/video URL and store its envelope. Browser/Tauri only (Web
// Audio). Returns true when an envelope was produced. Resolves silently to
// false for sources without an audio track or on decode error.
export async function analyzeAudioFromUrl(url, bucketsPerSecond = 60) {
  if (!url || typeof fetch !== "function") return false;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;
  let context = null;
  try {
    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    context = new Ctx();
    const audioBuffer = await context.decodeAudioData(bytes);
    const envelope = analyzeAudioBuffer(audioBuffer, bucketsPerSecond);
    setAudioEnvelope(envelope, bucketsPerSecond);
    return envelope.length > 0;
  } catch (err) {
    console.warn("[audio] analysis skipped (no decodable audio track?)", err);
    clearAudioEnvelope();
    return false;
  } finally {
    try { await context?.close?.(); } catch (_) {}
  }
}

export function subscribeAudio(fn) {
  LISTENERS.add(fn);
  return () => LISTENERS.delete(fn);
}

function notify() {
  for (const fn of LISTENERS) {
    try {
      fn();
    } catch (err) {
      console.error("[audio] listener error", err);
    }
  }
}
