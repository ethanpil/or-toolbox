/**
 * OpenRouter wire types, written from docs/openrouter-api.md (section numbers in brackets).
 *
 * Owned by the API client. The exported names are part of the core contract (src/core/types.ts imports them);
 * field-level detail may be refined against the reference, but do not rename or remove exports.
 */

import type { OrError } from '../errors';

// --- shared ----------------------------------------------------------------------------------------

/** Wire `usage` object. `cost` is always present on billed JSON responses [§1]. */
export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Decisions and STT use input/output naming [§5.3, §8.2]. */
  input_tokens?: number;
  output_tokens?: number;
  /** STT: billed audio seconds [§5.3]. */
  seconds?: number;
  cost?: number | null;
  completion_tokens_details?: { reasoning_tokens?: number; [k: string]: unknown };
  prompt_tokens_details?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Provider routing preferences [§2.9]. Dedicated endpoints accept only subsets (see each request type). */
export interface ProviderPreferences {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  sort?: string;
  data_collection?: 'allow' | 'deny';
  zdr?: boolean;
  options?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

// --- chat [§2] -------------------------------------------------------------------------------------

export type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string; detail?: 'auto' | 'low' | 'high' | 'original' };
    }
  | { type: 'file'; file: { filename: string; file_data: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }
  | { type: 'video_url'; video_url: { url: string; processing?: 'agentic' | 'static' } };

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  name?: string;
}

export interface ChatRequest {
  model: string;
  /** Fallback models tried in order [§2.8]. */
  models?: string[];
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  seed?: number;
  stop?: string | string[];
  response_format?:
    | { type: 'text' }
    | { type: 'json_object' }
    | {
        type: 'json_schema';
        json_schema: {
          name: string;
          description?: string;
          strict?: boolean;
          schema: Record<string, unknown>;
        };
      };
  reasoning?: { effort?: string; max_tokens?: number; exclude?: boolean; enabled?: boolean };
  /** e.g. ['image','text'] or ['text','audio'] for output modalities [§3.1, §6]. */
  modalities?: string[];
  image_config?: Record<string, unknown>;
  audio?: { format?: string; voice?: string; [k: string]: unknown };
  provider?: ProviderPreferences;
  /** e.g. `[{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]` [§2.5]. */
  plugins?: Array<Record<string, unknown>>;
  session_id?: string;
  user?: string;
  [k: string]: unknown;
}

export interface ChatChoiceMessage {
  role: 'assistant';
  content: string | null;
  reasoning?: string | null;
  images?: Array<{ type?: 'image_url'; image_url: { url: string } }>;
  audio?: { data?: string; transcript?: string; format?: string; [k: string]: unknown };
  /** PDF parser output; echo it back to skip re-parsing [§2.5]. */
  annotations?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface ChatResponse {
  id: string;
  model: string;
  provider?: string;
  created?: number;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    native_finish_reason?: string | null;
    message: ChatChoiceMessage;
  }>;
  usage?: WireUsage;
}

/** Normalised events emitted while a chat stream is read. */
export type ChatStreamEvent =
  | { type: 'meta'; id: string; model: string; provider?: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; url: string }
  /** `data` is one base64 fragment; Lyria sends the whole MP3 as one fragment [§6.2]. */
  | { type: 'audio'; data: string; transcript?: string }
  | { type: 'finish'; reason: string | null }
  | { type: 'usage'; usage: WireUsage };

/** Assembled result of a chat stream. */
export interface ChatStreamResult {
  id: string;
  model: string;
  provider?: string;
  text: string;
  reasoning: string;
  images: string[];
  /** Base64 audio fragments in arrival order (music / audio output). Join, then decode once. */
  audioChunks: string[];
  /** Concatenated `delta.audio.transcript` text (speech-chat models; Lyria sends none). */
  audioTranscript: string;
  finishReason: string | null;
  usage: WireUsage | null;
}

// --- images [§3] -----------------------------------------------------------------------------------

export interface ImageRequest {
  model: string;
  prompt: string;
  n?: number;
  aspect_ratio?: string;
  resolution?: string;
  size?: string;
  quality?: string;
  output_format?: 'png' | 'jpeg' | 'webp' | 'svg';
  background?: 'auto' | 'transparent' | 'opaque';
  output_compression?: number;
  seed?: number;
  /** Only OpenAI models stream; others answer with a buffered JSON body, which the client also accepts. */
  stream?: boolean;
  /** https URLs or base64 `data:` URLs (see `readAsDataUrl` in src/core/files.ts) [§3.2]. */
  input_references?: Array<{ type: 'image_url'; image_url: { url: string } }>;
  /** `/images` accepts only `only, order, ignore, sort, allow_fallbacks, options` [§2.9]. */
  provider?: ProviderPreferences;
  [k: string]: unknown;
}

export interface GeneratedImage {
  /** Decoded image. */
  blob: Blob;
  mediaType: string;
}

export interface ImageResult {
  /** The body's `created`; `0` on some providers [§3.4], so do not rely on it. */
  created: number;
  images: GeneratedImage[];
  usage: WireUsage | null;
  /** `X-Generation-Id` (the body carries no id). */
  generationId: string | null;
  /**
   * Set when a stream failed (error event, dropped connection) after some images had completed: `images` holds
   * those, and their usage was reported. Without any completed image the call rejects instead.
   */
  error?: OrError;
}

// --- speech [§4] -----------------------------------------------------------------------------------

export type SpeechReference =
  | { type: 'input_audio'; input_audio: { data?: string; url?: string; format?: string } }
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface SpeechRequest {
  model: string;
  input: string;
  /** Provider-dependent; some providers require one (Kokoro), some accept none (Fish) [§4.2]. */
  voice?: string;
  /** Omitted: the client picks per model (`pcm` for Gemini TTS, which rejects mp3; `mp3` otherwise) [§0]. */
  response_format?: 'mp3' | 'pcm';
  speed?: number;
  /** Voice cloning / design: 1-3 audio clips (each optionally followed by a transcript) or one image [§4.1]. */
  input_references?: SpeechReference[];
  /** TTS honours only `zdr`, `data_collection` and `options` [§4.1]. */
  provider?: ProviderPreferences;
  session_id?: string;
  user?: string;
}

export interface SpeechResult {
  blob: Blob;
  /** From the response Content-Type, without parameters: `audio/mpeg` or `audio/pcm`. */
  mimeType: string;
  /** PCM parameters parsed from Content-Type (`audio/pcm;rate=24000;channels=1`); null for mp3. */
  sampleRate: number | null;
  channels: number | null;
  generationId: string | null;
}

// --- transcription [§5] ----------------------------------------------------------------------------

/** Client-level request; the client encodes it as JSON with base64 `input_audio` (the guide's form) [§5.1]. */
export interface TranscriptionRequest {
  model: string;
  /** Audio to transcribe. */
  audio: Blob;
  /** `input_audio.format`, e.g. `mp3`, `wav`, `webm`. Derived from `audio.type` / `filename` when absent. */
  format?: string;
  filename?: string;
  /** ISO-639-1; auto-detected when omitted. */
  language?: string;
  temperature?: number;
  /** Segment and word timestamps (`verbose_json` + `timestamp_granularities`). */
  timestamps?: boolean;
  /**
   * Speaker labels. Sent through `provider.options` (top-level `diarize` is rejected by every model tried, §0);
   * implies timestamps. The client throws before sending for models without a known option route
   * (see `diarizationRoute`).
   */
  diarize?: boolean;
  /** Vocabulary bias, each 1-100 chars; 400 when unsupported. */
  keyterms?: string[];
  /** STT honours only `zdr`, `data_collection` and `options`. */
  provider?: ProviderPreferences;
}

export interface TranscriptionSegment {
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  /** Trimmed (Whisper prefixes a space). */
  text: string;
  /** `speaker_label` when present, else the numeric `speaker` as a string. */
  speaker?: string;
}

export interface TranscriptionWord {
  start: number;
  end: number;
  /** Trimmed. */
  word: string;
  speaker?: string;
}

export interface TranscriptionResult {
  /** Trimmed. */
  text: string;
  language: string | null;
  duration: number | null;
  segments: TranscriptionSegment[];
  words: TranscriptionWord[];
  usage: WireUsage | null;
}

// --- video [§7] ------------------------------------------------------------------------------------

/** First/last frame. `data:` image URLs are accepted [§7.2]. */
export interface VideoFrameImage {
  type: 'image_url';
  image_url: { url: string };
  frame_type: 'first_frame' | 'last_frame';
}

/** Image references accept `data:` URLs; audio and video references must be public HTTPS URLs [§0, §7.2]. */
export type VideoReference =
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'audio_url'; audio_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } };

export interface VideoRequest {
  model: string;
  /** Optional only for models that can work from image input alone. */
  prompt?: string;
  /** Seconds; must be in the model's `supported_durations`. */
  duration?: number;
  /** e.g. `480p`, `720p`, `1080p`, `4K`; must be in `supported_resolutions`. */
  resolution?: string;
  /** e.g. `16:9`, `1:1`; must be in `supported_aspect_ratios`. */
  aspect_ratio?: string;
  /** `WIDTHxHEIGHT`, interchangeable with resolution + aspect_ratio. */
  size?: string;
  /** Wins over `input_references` when both are sent. */
  frame_images?: VideoFrameImage[];
  input_references?: VideoReference[];
  /** A completed job to extend; only some models accept it (unsupported ones fail fast with a free 400). */
  previous_job_id?: string;
  /** Defaults to the endpoint's `generate_audio` flag. */
  generate_audio?: boolean;
  seed?: number;
  /** Video accepts only passthrough options (keys in `allowed_passthrough_parameters`). */
  provider?: { options?: Record<string, Record<string, unknown>> };
  session_id?: string;
  user?: string;
}

/** Remote job states. `in_progress` was never observed live, only `pending` → `completed` [§7.3]. */
export type VideoJobState =
  'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';

/** Normalised `POST /videos` (202) and `GET /videos/{id}` bodies. */
export interface VideoJobStatus {
  /** Opaque job id (`gen-vid-…`); never parse it. */
  id: string;
  status: VideoJobState;
  /** True for `completed`, `failed`, `cancelled` and `expired`. */
  done: boolean;
  generationId: string | null;
  /** Number of clips downloadable with `videos.content(id, { index })`. */
  outputs: number;
  /** `usage.cost` from the completed poll. The status read has no run: the tool adds this to its run. */
  costUsd: number | null;
  /** Failure text from the job (`failed`/`cancelled`/`expired`). */
  error: string | null;
}

// --- decisions [§8] --------------------------------------------------------------------------------

export type DecisionValue = string | Record<string, unknown> | unknown[];

export type DecisionQuestion =
  | {
      type: 'noul';
      instructions: DecisionValue;
      criteria?: { true: DecisionValue; false: DecisionValue };
    }
  | { type: 'choice'; instructions: DecisionValue; criteria: Record<string, DecisionValue | null> }
  | { type: 'score'; instructions: DecisionValue; criteria: DecisionValue[] };

export interface DecisionRequest {
  model: string;
  state: DecisionValue;
  questions: Record<string, DecisionQuestion>;
  provider?: ProviderPreferences;
  session_id?: string;
}

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | {
      type: 'score';
      score: number;
      confidence?: number;
      probabilities?: Record<string, number>;
      legend?: Record<string, DecisionValue>;
    };

export interface DecisionResponse {
  id: string;
  /** Dated snapshot of the requested model, e.g. `typesafe/jev-1.13-20260917`. */
  model: string;
  provider?: string;
  answers: Record<string, DecisionAnswer>;
  usage?: WireUsage;
}

// --- catalog and account [§9, §10, §11] -----------------------------------------------------------

/** Catalog entry exactly as returned by `GET /models` [§9.3]. */
export interface RawModel {
  id: string;
  canonical_slug?: string;
  name: string;
  created: number;
  description?: string;
  context_length: number | null;
  architecture: {
    modality?: string;
    input_modalities: string[];
    output_modalities: string[];
    tokenizer?: string;
    instruct_type?: string | null;
  };
  /** USD as strings; the unit is per token only for text models; `"-1"` on routers [§9.3]. */
  pricing: Record<string, unknown>;
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
    is_moderated?: boolean;
  };
  per_request_limits?: unknown;
  supported_parameters?: string[];
  supported_voices?: string[] | null;
  expiration_date?: string | null;
  alias_target?: { name: string; slug: string };
  reasoning?: {
    supported_efforts?: string[] | null;
    default_effort?: string;
    default_enabled?: boolean;
    mandatory?: boolean;
    supports_max_tokens?: boolean;
  };
  [k: string]: unknown;
}

/** One provider endpoint from `GET /models/{author}/{slug}/endpoints` [§9.3]. */
export interface RawModelEndpoint {
  name: string;
  provider_name: string;
  context_length?: number | null;
  pricing: Record<string, unknown>;
  max_completion_tokens?: number | null;
  supported_parameters?: string[];
  status?: number;
  supports_voice_cloning?: boolean;
  [k: string]: unknown;
}

/** `GET /images/models` entry [§3.5]. */
export interface RawImageModel {
  id: string;
  name: string;
  description?: string;
  /** Field name → `{type:'enum',values}` | `{type:'range',min,max}` | `{type:'boolean'}`; absent = unsupported. */
  supported_parameters: Record<string, unknown>;
  supports_streaming?: boolean;
  [k: string]: unknown;
}

/** `GET /videos/models` entry [§7.5]. */
export interface RawVideoModel {
  id: string;
  canonical_slug?: string;
  name?: string;
  created?: number;
  description?: string;
  supported_resolutions?: string[] | null;
  supported_aspect_ratios?: string[] | null;
  supported_sizes?: string[] | null;
  /** null for editors/upscalers: leave those out of a text-to-video picker. */
  supported_durations?: number[] | null;
  supported_frame_images?: Array<'first_frame' | 'last_frame'> | null;
  generate_audio?: boolean | null;
  seed?: boolean | null;
  /** SKU → price string. Names and units vary per family (USD/s, cents/s, USD/token) [§7.5]. */
  pricing_skus?: Record<string, string> | null;
  allowed_passthrough_parameters?: string[];
  [k: string]: unknown;
}

export interface KeyStatusResponse {
  data: {
    label?: string | null;
    usage: number;
    usage_daily?: number;
    usage_weekly?: number;
    usage_monthly?: number;
    limit: number | null;
    limit_remaining: number | null;
    limit_reset?: string | null;
    is_free_tier: boolean;
    free_model_daily_requests?: { used: number; limit: number; remaining: number };
    [k: string]: unknown;
  };
}

export interface CreditsResponse {
  data: { total_credits: number; total_usage: number };
}
