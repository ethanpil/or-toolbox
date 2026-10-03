/**
 * Shipped default model per capability, chosen from the live catalog of 2026-10-02 (prices are per million
 * tokens unless stated). `paid` is cheap, fast and good; `free` is the best `:free` model, or null when none
 * exists. Users override these in Settings → Defaults; free-only mode swaps to `free`.
 */

import type { Capability } from '../types';

export interface ShippedDefault {
  paid: string;
  free: string | null;
  reason: string;
}

export const SHIPPED_DEFAULTS: Readonly<Record<Capability, ShippedDefault>> = {
  text: {
    paid: 'openai/gpt-6-luna',
    free: 'qwen/qwen3.8-27b:free',
    reason:
      'Luna: $0.10/$0.50 with structured outputs and the best intelligence index (38) under $1 output; Qwen 3.8 27B is the best-rated free model with structured outputs (index 34).',
  },
  vision: {
    paid: 'google/gemini-3.1-flash-lite',
    free: 'qwen/qwen3.8-27b:free',
    reason:
      'Flash-Lite: native image, PDF and audio input with structured outputs and minimal reasoning by default (fast) at $0.25/$1.50; Qwen 3.8 27B: free, image input, structured outputs.',
  },
  image: {
    paid: 'black-forest-labs/flux.2-klein-4b',
    free: null,
    reason:
      'FLUX.2 klein on /images: $0.014 per megapixel, about 4 s per image, and edits from data-URL references (probed); /images also works for spend-limited keys where chat image output needs $1 of balance. No free image model exists.',
  },
  tts: {
    paid: 'hexgrad/kokoro-82m',
    free: 'fish-audio/s2.1-pro-free:free',
    reason:
      'Kokoro: cheapest TTS even at its priciest endpoint ($4 per million characters), 54 voices, mp3 and pcm (needs an explicit voice); Fish S2.1 Pro is the only free speech model.',
  },
  stt: {
    paid: 'openai/whisper-large-v3-turbo',
    free: null,
    reason:
      'Whisper large v3 turbo: about $0.012 per hour with segment and word timestamps (probed); use Deepgram Nova 3 when speaker labels are needed. No free transcription model exists.',
  },
  video: {
    paid: 'x-ai/grok-imagine-video',
    free: null,
    reason:
      'Grok Imagine Video: $0.05 per second at 480p, 1-15 s clips with audio, first-frame data URLs, a 1 s clip in about 6 s (probed). No free video model exists.',
  },
  music: {
    paid: 'google/lyria-3-clip-preview',
    free: null,
    reason:
      'Lyria 3 Clip: a flat $0.04 per 30 s clip (Pro is $0.08 per 3-minute song). No free music model exists.',
  },
  decisions: {
    paid: 'typesafe/jev-1.13',
    free: 'inception/mercury-decide:free',
    reason:
      'Jev 1.13: $0.042 per million input tokens (output is free), the model the decisions schema is written for; Mercury Decide accepts the same schema for free (probed).',
  },
};
