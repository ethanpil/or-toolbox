/**
 * What each transcription model accepts beyond plain audio. None of this is machine-readable in the catalog
 * (docs/openrouter-api.md §5.1, §5.2), so it is a small table of what the reference documents or the probes saw:
 *
 * - Timestamps (`verbose_json`): every model except the two the docs name as refusing it.
 * - Speaker labels: only through `provider.options`, and only where a working route is known
 *   (`diarizationRoute`: Deepgram and MAI-Transcribe, §0, §5.4). They need `verbose_json` too.
 * - Vocabulary (`keyterms`): 400 when unsupported; sent only to the providers whose own APIs take a key-term list
 *   (Deepgram's keyterm prompting, AssemblyAI's keyterms prompt). Others get the plain request.
 * - Length of one request: AssemblyAI Universal-3.5 Pro takes up to 120 s (§5.2); everyone else is limited by the
 *   tool's own part length (and the 25 MB body limit, which the longest part stays under).
 */
import { diarizationRoute } from '../../core/api/client';

export interface SttSupport {
  /** Segment and word timestamps (`verbose_json`). */
  timestamps: boolean;
  /** Speaker labels through a known `provider.options` route. */
  diarization: boolean;
  /** A vocabulary list (`keyterms`) is known to be accepted. */
  keyterms: boolean;
  /** The longest audio one request may carry, in seconds, when the model has its own limit. */
  maxPartSeconds: number | null;
}

/** The docs name these as refusing `verbose_json` (§5.1). */
const NO_TIMESTAMPS = /^(openai\/gpt-4o(-mini)?-transcribe|microsoft\/mai-transcribe-1\.5)/;
const KEYTERMS = /^(deepgram|assemblyai)\//;
/** Per-model request limits from model descriptions (§5.2), with a margin for the planner's one-second tail. */
const PART_LIMITS: readonly [RegExp, number][] = [[/^assemblyai\//, 110]];

export function sttSupport(model: string | null): SttSupport {
  if (!model)
    return { timestamps: true, diarization: false, keyterms: false, maxPartSeconds: null };
  const timestamps = !NO_TIMESTAMPS.test(model);
  return {
    timestamps,
    diarization: timestamps && diarizationRoute(model) !== null,
    keyterms: KEYTERMS.test(model),
    maxPartSeconds: PART_LIMITS.find(([pattern]) => pattern.test(model))?.[1] ?? null,
  };
}

/** The part length actually used: the chosen one, or less when the model has its own limit. */
export function partSeconds(chosenMinutes: number, model: string | null): number {
  const chosen = Math.max(30, Math.round(chosenMinutes * 60));
  const limit = sttSupport(model).maxPartSeconds;
  return limit ? Math.min(chosen, limit) : chosen;
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
