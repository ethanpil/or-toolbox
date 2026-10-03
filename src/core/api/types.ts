/**
 * OpenRouter wire types, written from docs/openrouter-api.md (section numbers in brackets).
 *
 * Owned by the API client. The exported names are part of the core contract (src/core/types.ts imports them);
 * field-level detail may be refined against the reference, but do not rename or remove exports.
 */

// --- shared ----------------------------------------------------------------------------------------

/** Wire `usage` object. `cost` is always present on billed JSON responses [Â§1]. */
export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Decisions use input/output naming [Â§8.2]. */
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  completion_tokens_details?: { reasoning_tokens?: number; [k: string]: unknown };
  prompt_tokens_details?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Provider routing preferences [Â§2.9]. */
export interface ProviderPreferences {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  sort?: string;
  data_collection?: 'allow' | 'deny';
  zdr?: boolean;
  options?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

// --- chat [Â§2] -------------------------------------------------------------------------------------

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | { type: 'file'; file: { filename: string; file_data: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  name?: string;
}

export interface ChatRequest {
  model: string;
  /** Fallback models tried in order [Â§2.8]. */
  models?: string[];
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  seed?: number;
  stop?: string | string[];
  response_format?:
    | { type: 'json_object' }
    | {
        type: 'json_schema';
        json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> };
      };
  reasoning?: { effort?: string; max_tokens?: number; exclude?: boolean; enabled?: boolean };
  /** e.g. ['image','text'] or ['text','audio'] for output modalities [Â§3.1, Â§6]. */
  modalities?: string[];
  audio?: { format?: string; voice?: string; [k: string]: unknown };
  provider?: ProviderPreferences;
  plugins?: Array<Record<string, unknown>>;
  session_id?: string;
  user?: string;
  [k: string]: unknown;
}

export interface ChatChoiceMessage {
  role: 'assistant';
  content: string | null;
  reasoning?: string | null;
  images?: Array<{ type: 'image_url'; image_url: { url: string } }>;
  audio?: { data?: string; transcript?: string; format?: string; [k: string]: unknown };
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
  /** Base64 audio chunks in arrival order (music / audio output). */
  audioChunks: string[];
  finishReason: string | null;
  usage: WireUsage | null;
}

// --- images [Â§3] -----------------------------------------------------------------------------------

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
  stream?: boolean;
  input_references?: Array<{ type: 'image_url'; image_url: { url: string } }>;
  provider?: ProviderPreferences;
  [k: string]: unknown;
}

export interface GeneratedImage {
  /** Decoded image. */
  blob: Blob;
  mediaType: string;
}

export interface ImageResult {
  created: number;
  images: GeneratedImage[];
  usage: WireUsage | null;
}

// --- speech / transcription [Â§4, Â§5] â€” complete from the reference --------------------------------

export interface SpeechRequest {
  model: string;
  input: string;
  voice?: string;
  response_format?: 'mp3' | 'pcm';
  speed?: number;
  provider?: ProviderPreferences;
  [k: string]: unknown;
}

export interface SpeechResult {
  blob: Blob;
  /** From the response Content-Type. */
  mimeType: string;
  /** PCM parameters parsed from Content-Type when present. */
  sampleRate: number | null;
  channels: number | null;
  generationId: string | null;
}

export interface TranscriptionRequest {
  model: string;
  /** Audio to transcribe; the client encodes it as the endpoint requires. */
  audio: Blob;
  filename?: string;
  language?: string;
  prompt?: string;
  /** Ask for segment timestamps when the model supports them. */
  timestamps?: boolean;
  [k: string]: unknown;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TranscriptionResult {
  text: string;
  language: string | null;
  duration: number | null;
  segments: TranscriptionSegment[];
  usage: WireUsage | null;
}

// --- video [Â§7] â€” complete from the reference -----------------------------------------------------

export interface VideoRequest {
  model: string;
  prompt: string;
  [k: string]: unknown;
}

export interface VideoJobStatus {
  id: string;
  status: string;
  [k: string]: unknown;
}

// --- decisions [Â§8] --------------------------------------------------------------------------------

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
  model: string;
  provider?: string;
  answers: Record<string, DecisionAnswer>;
  usage?: WireUsage;
}

// --- catalog and account [Â§9, Â§10, Â§11] -----------------------------------------------------------

/** Catalog entry exactly as returned by `GET /models` [Â§9.3]. */
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
  [k: string]: unknown;
}

/** One provider endpoint from `GET /models/{author}/{slug}/endpoints` [Â§9.3]. */
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

/** `GET /images/models` entry [Â§3.5]. */
export interface RawImageModel {
  id: string;
  name: string;
  description?: string;
  supported_parameters: Record<string, unknown>;
  supports_streaming?: boolean;
  [k: string]: unknown;
}

/** `GET /videos/models` entry [Â§7.5]. */
export interface RawVideoModel {
  id: string;
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
