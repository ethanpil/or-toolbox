/**
 * What each transcription model accepts beyond plain audio. None of this is machine-readable in the catalog
 * (docs/openrouter-api.md §5.1, §5.2), so it is a small table of what the reference documents or the probes saw:
 *
 * - Timestamps (`verbose_json`): every model except the two the docs name as refusing it.
 * - Speaker labels: only through `provider.options`, and only where a working route is known
 *   (`diarizationRoute`: Deepgram and MAI-Transcribe, §0, §5.4). They need `verbose_json` too.
 * - Vocabulary (`keyterms`): 400 when unsupported; sent only to the providers whose own APIs take a key-term list
 *   (Deepgram's keyterm prompting, AssemblyAI's keyterms prompt). Others get the plain request.
 * - Length of one request (§5.2): AssemblyAI Universal-3.5 Pro takes up to 120 s, Meta Muse Voice Transcribe 10 min;
 *   everyone else is limited by the tool's own part length (and the 25 MB body limit the longest part stays under).
 * - Audio format (§5.2): Meta Muse Voice Transcribe takes only mono 16-bit PCM WAV at 16 or 24 kHz, so its audio
 *   always goes through the decoder (which writes exactly that, at 16 kHz), never as the file was.
 */
import { diarizationRoute } from '../../core/api/client';
import { formatDuration } from '../../core/files';

export interface SttSupport {
  /** Segment and word timestamps (`verbose_json`). */
  timestamps: boolean;
  /** Speaker labels through a known `provider.options` route. */
  diarization: boolean;
  /** A vocabulary list (`keyterms`) is known to be accepted. */
  keyterms: boolean;
  /** The longest audio one request may carry, in seconds, when the model has its own limit. */
  maxPartSeconds: number | null;
  /** Only mono 16-bit PCM WAV (16 kHz here) is accepted: files are always decoded and re-encoded. */
  pcmWavOnly: boolean;
}

/** The docs name these as refusing `verbose_json` (§5.1). */
const NO_TIMESTAMPS = /^(openai\/gpt-4o(-mini)?-transcribe|microsoft\/mai-transcribe-1\.5)/;
const KEYTERMS = /^(deepgram|assemblyai)\//;
const MUSE_VOICE = /muse-?voice-?transcribe/i;
/** Per-model request limits from model descriptions (§5.2), with a margin for the planner's one-second tail. */
const PART_LIMITS: readonly [RegExp, number][] = [
  [/^assemblyai\//, 110],
  [MUSE_VOICE, 590],
];
/** Models that take only mono 16-bit PCM WAV (§5.2). */
const PCM_WAV_ONLY: readonly RegExp[] = [MUSE_VOICE];

export function sttSupport(model: string | null): SttSupport {
  if (!model) {
    return {
      timestamps: true,
      diarization: false,
      keyterms: false,
      maxPartSeconds: null,
      pcmWavOnly: false,
    };
  }
  const timestamps = !NO_TIMESTAMPS.test(model);
  return {
    timestamps,
    diarization: timestamps && diarizationRoute(model) !== null,
    keyterms: KEYTERMS.test(model),
    maxPartSeconds: PART_LIMITS.find(([pattern]) => pattern.test(model))?.[1] ?? null,
    pcmWavOnly: PCM_WAV_ONLY.some((pattern) => pattern.test(model)),
  };
}

/** The part length actually used: the chosen one, or less when the model has its own limit. */
export function partSeconds(chosenMinutes: number, model: string | null): number {
  const chosen = Math.max(30, Math.round(chosenMinutes * 60));
  const limit = sttSupport(model).maxPartSeconds;
  return limit ? Math.min(chosen, limit) : chosen;
}

/**
 * Why audio already cut for one model cannot go to `model` as it is (too long a part, or a format it does not
 * take), or null when it can. The planner may run a part one second over its limit.
 */
export function partsUnfitFor(
  model: string,
  parts: readonly { duration: number; format: string }[],
  chosenMinutes: number,
): string | null {
  const limit = partSeconds(chosenMinutes, model);
  if (parts.some((part) => part.duration > limit + 1)) {
    return `${model} takes at most ${formatDuration(limit)} per request, and these parts are longer. Transcribe the whole recording again with it.`;
  }
  if (sttSupport(model).pcmWavOnly && parts.some((part) => part.format !== 'wav')) {
    return `${model} takes only WAV audio. Transcribe the whole recording again with it.`;
  }
  return null;
}

/** Splits the vocabulary field into terms: commas, semicolons or new lines; 1-100 characters each; no repeats. */
export function parseKeyterms(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const term = raw.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
  }
  return terms;
}
