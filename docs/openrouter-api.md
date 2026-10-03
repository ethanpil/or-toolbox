# OpenRouter API reference for ORtoolbox

Single source of API truth for the toolbox. Captured **2026-10-02** from OpenRouter's published docs (`llms.txt`, per-page `.md` files, `openapi.json`), from keyless live requests, and from authenticated probes with a throwaway key in two rounds: (1) free models only, about 17 generation requests; (2) a small paid round (cap $3.00; **actual spend about $0.43**, ledger in section 16) that exercised video, image generation/editing/streaming, TTS, STT, music (Lyria Clip and Pro), Jev decisions and PDF input. Still never exercised live: native video continuation (`previous_job_id` on a model that supports it), the chat-route image output (402, see section 3), and the account's own free-tier 429.

## How to read this document

Every statement carries one of three tags.

| Tag | Meaning |
| --- | --- |
| **[doc]** | Read in OpenRouter's docs or OpenAPI spec on 2026-10-02. The source URL is given per section. |
| **[probed]** | Observed in a live request made on 2026-10-02: keyless, with a deliberately fake key, or authenticated (free models, then a small paid round). Authenticated recordings are `tests/fixtures/openrouter/*.recorded.*` (identifiers redacted, base64 truncated); small real media is in `tests/fixtures/media/`. |
| **[unverified]** | Could not be confirmed. The text says what is still unknown and how to find out. |

Where the docs contradict each other, both versions are listed and the conflict is called out.

Raw sources used: `https://openrouter.ai/docs/llms.txt`, `https://openrouter.ai/docs/llms-full.txt`, `https://openrouter.ai/openapi.json`, and `https://openrouter.ai/docs/<page>.md` for each page cited below. Fixtures referenced here live in `tests/fixtures/openrouter/` (index at the end).

---

## 0. Corrections to PLAN.md (read first)

| PLAN.md says | What the API actually does |
| --- | --- |
| `POST /images` **or** chat with image output | **Use `POST /api/v1/images`.** Probed live: generation, editing (base64 `data:` URL in `input_references` + instruction) and OpenAI SSE streaming all work. The chat route (`modalities:["image","text"]`) returned **402 "This request requires at least $1.00 in balance for image or video output"** (`limit_source: openrouter_key_limit`) for a key with <$1 of limit remaining, whereas `/images` and `/videos` worked with the same key, so spend-limited keys must use `/images`. **[doc]** **[probed]** |
| Image editor uses a painted **mask** for inpaint/outpaint | **No mask parameter exists** on `/images` or in the chat schema (searched spec and all docs). Editing = `input_references` (images) + prompt. **[probed]** an edit with a 1024x1024 JPEG sent as a base64 data URL plus "Change the red circle to blue; keep everything else the same" returned a 1024x1024 JPEG with the circle recoloured (centre pixel (227,0,9) -> (5,139,252)) for $0.015 on `black-forest-labs/flux.2-klein-4b`. A mask must be expressed by sending a marked-up image plus instructions. |
| TTS output MP3 / WAV | `response_format` is only `mp3` or `pcm` (default **`pcm`**), never `wav`: build the WAV header client-side. **[doc]** **Format support is per model:** `google/gemini-3.8-flash-tts` returns **400 `Gemini TTS only supports response_format="pcm". Got "mp3".`** (free), so the tool must be able to transcode PCM to MP3 in the browser. **[probed]** **The PCM sample rate is in the response `Content-Type`**: `audio/pcm;rate=44100;channels=1` (Fish), `audio/pcm;rate=24000;channels=1` (Kokoro and Gemini); parse `rate`/`channels`. **[probed]** Some providers require an explicit `voice` (Kokoro: 400 `An explicit voice is required for this TTS provider.`); Fish did not. **[probed]** The docs' example model `openai/gpt-4o-mini-tts-2025-12-15` is **not in the catalog** (404, and no OpenAI model among the 23 `speech` models). **[probed]** |
| Decision: "Yes/No" questions | The type is named **`noul`**, and its answer is `{type:"noul", noul:<P(yes)>}` with **no `confidence` field**. `confidence` exists only on `choice` and `score`. **[doc]** [probed on the free model `inception/mercury-decide:free`: same request schema accepted, answers as documented] |
| Decision endpoint `POST /api/alpha/decisions` | Full URL is `https://openrouter.ai/api/alpha/decisions` (**not** under `/api/v1`). `/api/v1/api/alpha/decisions` and `/api/v1/decisions` return 404. The OpenAPI file lists it under the `/api/v1` server, which is wrong. **[probed]** |
| Music: lyrics / instrumental / duration fields | **No request fields exist; everything is prompt text, and duration is not controllable.** Lyria's `supported_parameters` are only `max_tokens, response_format, seed, temperature, top_p`. **[probed]** with both models (`modalities:["text","audio"]`, `stream:true`, no `audio` object): **Clip returns a 30.8 s MP3, Pro a 180.1 s MP3**, even when the prompt said "10 second". The audio arrives as **one single `delta.audio.data` base64 chunk** (Clip 745 KB, Pro 4.3 MB decoded; the stream is 1.0 MB and 5.8 MB), **MP3 44.1 kHz stereo 192 kbps with an ID3v2.3 header carrying a C2PA manifest**, not WAV. `audio:{format:"wav"}` is accepted and **ignored**. The lyrics come back as timestamped text in `delta.content` (`[0.0:3.7] HELLO WORLD, HELLO DAY`; Pro adds section markers `[[A0]] [[B1]]` and expands/repeats lyrics to fill the song; instrumental gives `<instrumental>`), so `[Verse]`/`[Chorus]` tags in the prompt are honoured. `usage.cost` is the flat **$0.04 (Clip) / $0.08 (Pro)**. 17 (Clip) and 76 (Pro) `: OPENROUTER PROCESSING` keep-alive lines arrive during the 10 s and 43 s wait. An image content part is accepted. |
| Video: "OpenRouter appears to reject local `data:` URLs for video" and native extend | **Split result.** `data:` URLs are **accepted for images** in `frame_images` (first **and** last frame, tested on grok-imagine-video and Seedance 2.0 mini) and in image `input_references` (grok). They are **rejected for video**: `input_references[].video_url` with a `data:video/mp4;...` URL returns **400 `Invalid reference URL: input_references[0].video_url.url: Only HTTPS URLs are allowed`** (free). So "Continue from last frame" works with no hosting, but native extend by uploaded video needs a public HTTPS URL, as PLAN assumed. **[probed]** For continuation of a *generated* clip there is `previous_job_id`, but it is per model: `x-ai/grok-imagine-video` and `bytedance/seedance-2.0-mini` both reject it with **400 `<model-snapshot> does not support previous_job_id`** (free); which model accepts it is still **[unverified]** (FLUX.3 Video is the likely one; a probe costs $0.85+). **[probed]** |
| Video: "download links need the user's key" | Correct. `GET /videos/{id}/content?index=0` **requires `Authorization`** (401 without), returns **200 `video/mp4` with `Transfer-Encoding: chunked` and no `Content-Length`**, **no redirect**, ignores `Range` (full 200, not 206), and carries `Access-Control-Allow-Origin: *`; the preflight is 204. `unsigned_urls[0]` was exactly the same-host content URL. Fetch to a Blob. **[probed]** A finished video was still downloadable, byte-identical, 18 minutes later; the real retention limit is still unknown (section 7.4). |
| App attribution header `X-Title` | Current name is **`X-OpenRouter-Title`** (`X-Title` still supported). `HTTP-Referer` is required for attribution. Both pass CORS preflight. **[doc]** [probed] |
| PKCE connect "can request a limit" | The `/auth` URL has **no documented limit parameter** (only `callback_url`, `code_challenge`, `code_challenge_method`, `key_label`, `workspace_id`, `required_workspace_id`, `state`). A `limit` exists only on `POST /auth/keys/code`, which needs authentication, so it cannot be used for first sign-in. **[doc]** |
| Free model = `:free` suffix | Correct, and **zero price is not a free signal**: 107 of 647 catalog entries have `pricing.prompt == "0" && pricing.completion == "0"` but only 24 end in `:free` (image/video/rerank models price through other fields). **[probed]** |
| Cost via `usage` accounting flag | `usage: {include: true}` and `stream_options.include_usage` are **deprecated no-ops**; `usage` (with `cost`) is always returned. **[doc]** **[probed]** `usage.cost` is present by default on chat (JSON and SSE), `/images` (JSON and SSE), STT and decisions, and in the completed `/videos/{id}` poll. TTS and the video content endpoint return raw bytes with no cost, so cost needs `GET /generation` (below). |
| `GET /credits` for balance | The docs say it needs a **management key**, but it returned **200 for an ordinary key** (`is_management_key:false`) with `{data:{total_credits,total_usage}}` (account-level totals, not per-key). **[probed]** Treat it as available but undocumented-for-ordinary-keys; fall back to `GET /key` if it ever returns 401/403. |
| Preferring non-retaining providers is a harmless per-key setting | `provider.data_collection:"deny"` **excludes free models**: a request to a `:free` model with it returns `404 "No endpoints found matching your data policy (Free model training)"`. So "free-only mode" and "no-retention" cannot be combined for text models. **[probed]** |
| STT diarization via top-level `diarize` | The spec's top-level `diarize:true` was **rejected with 400 `The selected model does not support diarize...` for all four models tried** (`openai/whisper-large-v3-turbo`, `x-ai/grok-stt-1.0`, `microsoft/mai-transcribe-2`, `deepgram/nova-3`; free). The **provider-option route works**: `provider.options.deepgram.diarize:true` and `provider.options.azure.diarization.enabled:true` both returned `speaker` indexes on `segments[]` and `words[]`. Use provider options. **[probed]** |
| Reading cost and usage after the fact | `GET /generation?id=<X-Generation-Id>` **does work** for every type (`api_type`: `completions`, `image`, `video`, `tts`, `stt`, `decisions`) but is **eventually consistent**: 404 for the first ~1 to 8 minutes (images found at ~2.5 min, TTS at 5.7 min; two free-model ids still 404 at 8 min and found at ~50 min). `GET /key` `usage` also lags by minutes (it read $0.353 while about $0.43 had been spent) and `free_model_daily_requests.used` had not advanced. Do not use either for live budget checks; use `usage.cost` from responses and a local ledger. **[probed]** |
| TTS price shown in the catalog | `/models` `pricing` shows only the **cheapest endpoint**. A `hexgrad/kokoro-82m` request was routed to Together and billed **$0.000176 for 44 characters ($4/M chars) while the catalog says $0.62/M chars (DeepInfra)**: 6.5x higher. `provider.order/only/sort` are not applied to speech requests, so estimate with the **highest** endpoint price from `GET /models/{id}/endpoints`. **[probed]** |

---

## 1. Conventions shared by every endpoint

**Base URL:** `https://openrouter.ai/api/v1` **[doc]**. Exception: Decisions is `https://openrouter.ai/api/alpha/decisions` **[doc]** [probed].

**Auth:** `Authorization: Bearer <key>` **[doc]**. Keyless public endpoints ignore a bad bearer and still return 200 **[probed]**: `GET /models`, `/models/count`, `/models/{author}/{slug}/endpoints`, `/videos/models`, `/images/models`, `/images/models/{author}/{slug}/endpoints`, `/endpoints/zdr`. An invalid key on an authenticated route returns `401 {"error":{"message":"User not found.","code":401}}`; a missing key returns `401 {"error":{"message":"No cookie auth credentials found","code":401}}` **[probed]**.

**Request headers worth sending** (all pass CORS preflight **[probed]**):

| Header | Purpose |
| --- | --- |
| `Content-Type: application/json` | Required for JSON bodies. |
| `HTTP-Referer: https://<site>` | App identifier; **required** for attribution/rankings **[doc]**. |
| `X-OpenRouter-Title: ORtoolbox` | App display name. `X-Title` is the legacy alias and still works **[doc]**. |
| `X-OpenRouter-Categories: image-gen,audio-gen` | Optional; max 2 per request; lowercase, hyphenated, <=30 chars; unrecognised values dropped silently. Recognised: `cli-agent ide-extension cloud-agent programming-app native-app-builder creative-writing video-gen image-gen audio-gen writing-assistant general-chat personal-agent legal roleplay game` **[doc]**. |
| `X-OpenRouter-App-Visibility: hidden` | Creates a *new* app hidden from public rankings; ignored once the app exists **[doc]**. |
| `X-Session-Id` / body `session_id` | Grouping; body wins; max 256 chars **[doc]**. |

**Do not send** `X-OpenRouter-Metadata` from the browser: it is not in the server's `Access-Control-Allow-Headers`, so the preflight would fail **[probed]**. Localhost apps need `X-OpenRouter-Title` to be tracked **[doc]**.

Source: https://openrouter.ai/docs/app-attribution, https://openrouter.ai/docs/api_reference/authentication

**Usage and cost (all endpoints that bill):** every response carries `usage.cost` (USD, number) with no opt-in. For streams it is on the last chunk before `[DONE]`. **[doc]** **[probed]** on free models: `usage.cost` is present by default and equals `0` (chat non-stream, chat stream, decisions); sending `"usage":{"include":true}` is accepted with no effect (200, same shape), confirming it is a deprecated no-op. Raw-byte endpoints (TTS, video content) cannot carry it; the docs say to use `GET /generation?id=<X-Generation-Id>` afterwards (`api_type` includes `tts`, `stt`, `image`, `video`, `decisions`) **[doc]**. **[probed]** `GET /generation?id=...` works for chat, TTS, STT, image, video and decisions ids (`api_type` `completions|tts|stt|image|video|decisions`; the record has `total_cost`, `usage`, `model` (dated snapshot), `provider_name`, `tokens_prompt`, `tokens_completion`, `num_media_prompt`, `num_media_completion`, `latency`, `generation_time`, `streamed`, `finish_reason`, `origin`, ...; fixtures `generation-*.recorded.json`). It is **eventually consistent**: it returned `404 {"error":{"message":"Generation gen-... not found","code":404}}` at 1.3 minutes (TTS) and for free-model ids at about 3 and 8 minutes, but 200 for images at about 2.5 minutes, TTS at 5.7 minutes and every id at about 50 minutes (fixture `error-404-generation-not-found.recorded.json`). Retry with backoff for up to ~10 minutes if you need the figure; never block a UI on it. Source: https://openrouter.ai/docs/cookbook/administration/usage-accounting

**Exposed response headers:** only `X-Generation-Id, X-Provider-Name, request-id, cf-ray` appear in `Access-Control-Expose-Headers`, on keyless, error and authenticated 200/429/400 responses alike **[probed]**. `Retry-After` is not exposed (section 12.3). Note the exposed list names `X-Provider-Name`, but only the decisions response actually carried it; chat and TTS responses did not.

---

## 2. Chat completions

`POST https://openrouter.ai/api/v1/chat/completions` **[doc]**. Source: https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion (OpenAPI `ChatRequest` / `ChatResult`), https://openrouter.ai/docs/api_reference/streaming

### 2.1 Request fields (those the toolbox needs)

| Field | Type / allowed values |
| --- | --- |
| `model` | string. `models` is the fallback list (below). |
| `messages` | array of `{role:"system"\|"user"\|"developer"\|"assistant"\|"tool", content, name?}`. `content` is a string or an array of parts (see 2.4). |
| `stream` | boolean, default false. |
| `max_completion_tokens` / `max_tokens` | integer; `max_tokens` is deprecated; some providers enforce a minimum of 16. |
| `temperature` (0-2), `top_p` (0-1), `top_k`, `min_p`, `top_a`, `frequency_penalty`/`presence_penalty` (-2..2), `repetition_penalty`, `seed`, `stop` (string or up to 4) | as named. Support is per endpoint (`supported_parameters` in the catalog). |
| `response_format` | `{type:"text"}` \| `{type:"json_object"}` \| `{type:"json_schema", json_schema:{name (<=64, a-zA-Z0-9_-), description?, schema, strict?}}` \| `{type:"grammar", grammar}` \| `{type:"python"}` |
| `reasoning` | docs: `{effort?, max_tokens?, exclude?, enabled?}`; spec lists only `{effort, summary}` (conflict, see 2.7). `reasoning_effort` is a shorthand. |
| `provider` | routing object (2.9). |
| `plugins` | array; `{id:"file-parser", pdf:{engine}}` for PDFs (2.5). |
| `modalities` | array of `"text" \| "image" \| "audio"` (output modalities). |
| `image_config` | free-form object (string/number/array values), e.g. `{"aspect_ratio":"16:9","quality":"high"}`; keys vary by model. |
| `audio` | The audio guide shows `{voice, format}` but the OpenAPI `ChatRequest` has **no `audio` property** (conflict). |
| `session_id`, `user`, `metadata` (<=16 pairs), `trace`, `service_tier`, `cache_control`, `tools`, `tool_choice`, `parallel_tool_calls`, `prediction`, `logprobs`, `top_logprobs`, `logit_bias` | as in the spec. |
| `usage`, `stream_options.include_usage` | **Deprecated, no effect.** |

### 2.2 Non-streaming response **[doc]**

```json
{
  "choices": [{"finish_reason": "stop", "index": 0, "message": {"content": "The capital of France is Paris.", "role": "assistant"}}],
  "created": 1677652288, "id": "chatcmpl-123", "model": "openai/gpt-4", "object": "chat.completion",
  "system_fingerprint": "fp_44709d6fcb",
  "usage": {"completion_tokens": 10, "prompt_tokens": 25, "total_tokens": 35}
}
```

(Spec example, reflowed; real responses also carry `usage.cost`.)

**[probed] real response** (free model `liquid/lfm-2.5-2.6b:free`, fixture `chat-completion.recorded.json`). Top-level keys: `id` ("gen-<unix>-<20 chars>"), `object`, `created`, `model`, `provider` ("Liquid"), `system_fingerprint`, `service_tier` (null), `choices`, `usage`. Choice keys: `index, logprobs (null), finish_reason, native_finish_reason, message`. Message keys: `role, content, refusal (null), reasoning (string), reasoning_details[{type:"reasoning.text", text, format:"unknown", index}]`. `usage`: `prompt_tokens, completion_tokens, total_tokens, cost: 0, is_byok: false, prompt_tokens_details{cached_tokens, cache_write_tokens, audio_tokens, video_tokens}, cost_details{upstream_inference_cost, upstream_inference_prompt_cost, upstream_inference_completions_cost}` (all 0 on free), `completion_tokens_details{reasoning_tokens, image_tokens, audio_tokens}`. Response headers include `X-Generation-Id: gen-...` (same value as `id`), `Access-Control-Allow-Origin: *` and the exposed-headers list (`headers-authenticated.recorded.json`). A built example for other shapes is `chat-completion.documented.json`.

`choices[].finish_reason`: `tool_calls | stop | length | content_filter | error | null`. `message` may contain `content, refusal, reasoning, reasoning_details[], images[], audio{id,data,expires_at,transcript}, tool_calls[]`. Docs examples also show a top-level `provider` string, and PDF responses carry `message.annotations` (2.5); neither is in the OpenAPI `ChatResult` **[doc]**.

`usage` **[doc]** (`ChatUsage`): `prompt_tokens, completion_tokens, total_tokens` (required), `cost` (USD, number or null), `cost_details{upstream_inference_cost, upstream_inference_prompt_cost, upstream_inference_completions_cost, server_tool_cost}`, `is_byok`, `prompt_tokens_details{cached_tokens, cache_write_tokens, audio_tokens, video_tokens}`, `completion_tokens_details{reasoning_tokens, audio_tokens, accepted_prediction_tokens, rejected_prediction_tokens}`, `server_tool_use_details{...}`.

**Errors can arrive inside a 200.** If the provider returns headers and then fails, a non-streaming call gets `200` with a body holding only `error` and no `choices`; check `body.error` even on 200 **[doc]**. Fixture: `chat-completion-error-200.documented.json`.

### 2.3 Streaming (SSE) **[doc]**

Set `stream: true`. Response is `text/event-stream`; read it with `fetch` + `ReadableStream` (`EventSource` cannot POST).

* **Comment/keep-alive lines** begin with `:`, e.g. `: OPENROUTER PROCESSING`. Skip them before `JSON.parse` (parsing one throws).
* Each event is `data: {json}` followed by a blank line. The stream ends with `data: [DONE]`.
* Chunk shape: `{id, object:"chat.completion.chunk", created, model, choices:[{index, delta:{role?, content?, reasoning?, reasoning_details?, refusal?, tool_calls?, audio?}, finish_reason}], usage?}`.
* **Final usage chunk:** every chat stream ends with an extra chunk carrying `usage` just before `[DONE]`. It has one choice with a content-free delta repeating the finish reason (OpenAI would send an empty `choices`). The terminal `finish_reason` therefore appears twice:

```text
data: {"id":"gen-abc123",...,"choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"stop","native_finish_reason":"stop"}]}
data: {"id":"gen-abc123",...,"choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{...}}
data: [DONE]
```

* **Errors before the stream starts** are plain JSON with a 4xx/5xx status (shape in section 12).
* **Mid-stream errors** keep HTTP 200 and arrive as one `data:` event, then the stream ends. The error is at the top level, with a terminating choice (verbatim):

```text
data: {"id":"gen-abc123","object":"chat.completion.chunk","created":1234567890,"model":"openai/gpt-4o","provider":"OpenAI","error":{"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded"}},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}
```

  The error can be the **first and only** event, so treat a 200 carrying an `error` chunk with no content as a failure. `error.code` is an integer in the errors page and spec; one older streaming-page example shows the string `"server_error"`, so tolerate both. `error.metadata.error_type` is the stable key (list in section 12).
* Cancelling: abort the fetch. Billing stops immediately only for some providers (OpenAI, Anthropic, Azure, DeepSeek, ...); for Google, Google AI Studio, Mistral, Groq and others you are billed for the full response.
* Fixtures: `chat-stream.documented.json`, `chat-stream-midstream-error.documented.json` (each `lines` array is the raw SSE text, one element per line).

**[probed] real streams** (free model; exact bytes saved as `chat-stream.recorded.sse.txt`, `chat-stream-json-schema.recorded.sse.txt`, `chat-stream-reasoning-length.recorded.sse.txt`):

* Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Generation-Id`, `Access-Control-Allow-Origin: *`, exposed-headers list; chunked transfer.
* Framing is **LF only** (no CR): every event is `data: <json>\n\n`; the file ends `data: [DONE]\n\n`. Split on `\n`, not `\r\n`.
* Chunks use `delta.content: ""` plus `delta.role: "assistant"` on every chunk, and reasoning models stream `delta.reasoning` (string) and `delta.reasoning_details[]` before any visible `content`. The first chunks may carry only reasoning. Do not treat `content: ""` as the start or end of the answer.
* Termination matches the docs exactly: one chunk with `finish_reason:"stop"` and `native_finish_reason:"stop"`, then a second chunk with the same content-free delta, the same finish reason and the `usage` object (including `cost`), then `data: [DONE]`.
* **No `: OPENROUTER PROCESSING` comment line appeared** in these sub-5-second streams (0 comment lines in 3 recordings), so the keep-alive comment only shows up on slow starts: the Lyria streams (10 s and 43 s) carried 17 and 76 of them, and image streams carry empty `: ` comment lines. Keep skipping every line that starts with `:`.
* **Reasoning can consume the whole budget:** a 600-token cap on a mandatory-reasoning model streamed 116 KB of `reasoning` chunks and ended with `finish_reason:"length"`, empty `content` and `usage.completion_tokens_details.reasoning_tokens == completion_tokens` (recorded in `chat-stream-reasoning-length.recorded.sse.txt`). Still HTTP 200, no error event.

### 2.4 Content parts (user messages) **[doc]**

```json
{"type": "text", "text": "What's in this image?"}
{"type": "image_url", "image_url": {"url": "https://example.com/a.jpg", "detail": "auto"}}
{"type": "input_audio", "input_audio": {"data": "<base64>", "format": "wav"}}
{"type": "video_url", "video_url": {"url": "https://...", "processing": "static"}}
{"type": "file", "file": {"filename": "document.pdf", "file_data": "https://bitcoin.org/bitcoin.pdf"}}
```

* **Image input:** `image_url.url` is an `https` URL or a `data:image/<type>;base64,...` URL. Types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. **[probed]** a 32x32 solid-red `data:image/png;base64,...` (154 chars) sent to the free vision model `dots-studio/dots-3-note-preview:free` returned `200` and the answer "Red" (`chat-completion-vision.recorded.json`); the same request to `google/gemma-4-31b-it:free` got an upstream 429 (section 12.3), so free vision models can be flaky. `detail`: `auto | low | high | original` (`original` is an OpenRouter extension). Put the text part first. Image count limits are per model/provider. Source: https://openrouter.ai/docs/guides/overview/multimodal/image-understanding
* **Audio input:** content type `input_audio`, **base64 only, no URLs**. `format` examples: `wav mp3 aiff aac ogg flac m4a pcm16 pcm24`; supported formats vary by provider. Source: https://openrouter.ai/docs/guides/overview/multimodal/audio
* **Video input:** `video_url` (legacy alias `input_video`), `data:video/mp4;base64,...` allowed; URL support is provider-specific (e.g. Gemini on AI Studio accepts only YouTube links). `processing`: `agentic | static` (Gemini). Source: https://openrouter.ai/docs/guides/overview/multimodal/videos
* **File input:** `file_data` is a base64 `data:` URL or a URL; `filename`; or `file_id` from the (beta) Files API. Source: https://openrouter.ai/docs/guides/features/files-api

### 2.5 PDF input and the `plugins` / engine options **[doc]**

Works with any model. Send the PDF as a `file` part (URL or `data:application/pdf;base64,...`). Optional engine selection:

```json
{
  "plugins": [{ "id": "file-parser", "pdf": { "engine": "cloudflare-ai" } }]
}
```

| `pdf.engine` | Behaviour |
| --- | --- |
| `mistral-ocr` | Best for scans/images. Paid per 1,000 pages; billed to your OpenRouter account even with BYOK. At most 8 images per PDF forwarded. The per-page price is a template variable that did not render in the fetched text, so the number is **[unverified]**. This is the **default when the model has no native file input**, so omitting `plugins` can silently incur OCR charges: set `engine:"cloudflare-ai"` explicitly for the free path. |
| `cloudflare-ai` | PDF to markdown via Workers AI. **Free.** |
| `native` | Only for models with native file input; charged as input tokens. **Default first choice when available.** |
| `pdf-text` | Deprecated; redirected to `cloudflare-ai`. |

Annotations: the assistant message may include `annotations: [{type:"file", file:{hash, name?, content:[{type:"text"|"image_url", ...}]}}]`. Echo them back in a later request to skip re-parsing (and re-paying for OCR). On a provider failure after a successful parse, the same array is in `error.metadata.file_annotations`. Fixture: `chat-completion-reasoning-pdf.documented.json`. **[probed]** a 604-byte one-page text PDF (`tests/fixtures/media/invoice.pdf`) sent as `{type:"file", file:{filename, file_data:"data:application/pdf;base64,..."}}` with `plugins:[{id:"file-parser", pdf:{engine:"cloudflare-ai"}}]` to the free model `dots-studio/dots-3-note-preview:free` returned 200, `usage.cost: 0`, and the answer "Invoice number: 4711 / Total: 128.50 EUR". The parsed document came back in `choices[0].message.annotations[0]` as `{type:"file", file:{hash:<64 hex>, name:"invoice.pdf", content:[{type:"text",text:"<file name=\"invoice.pdf\">"}, {type:"text", text:"# document.pdf\n## Metadata\n- PDFFormatVersion=1.4 ...\n## Contents\n### Page 1\nInvoice 4711 total 128.50 EUR"}, {type:"text",text:"</file>"}]}}`. So the free engine is currently named **`cloudflare-ai`** (markdown with a metadata header and `### Page N` sections) and it works on a model without file input. Fixture `chat-completion-pdf.recorded.json`. Source: https://openrouter.ai/docs/guides/overview/multimodal/pdfs

### 2.6 Structured outputs (`response_format` json_schema) **[doc]**

```json
{
  "messages": [{ "role": "user", "content": "What's the weather like in London?" }],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "weather",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "City or location name" },
          "temperature": { "type": "number", "description": "Temperature in Celsius" },
          "conditions": { "type": "string", "description": "Weather conditions description" }
        },
        "required": ["location", "temperature", "conditions"],
        "additionalProperties": false
      }
    }
  }
}
```

Support is per endpoint. To force routing to capable endpoints set `provider.require_parameters: true` with `response_format` present. Catalog filter: `GET /models?supported_parameters=structured_outputs` returned 358 of 466 text models today; `response_format` returned 376 **[probed]**. `strict: true` enforcement varies by provider. **[probed]** A streaming request with `response_format.json_schema` (the weather schema above, `strict:true`) plus `provider.require_parameters:true` on the free model `dots-studio/dots-3-note-preview:free` returned 200; the concatenated `delta.content` parsed as valid JSON matching the schema (keys came back in alphabetical order with pretty-printed whitespace, so always `JSON.parse` and do not rely on key order) (`chat-stream-json-schema.recorded.sse.txt`). The same request on `liquid/lfm-2.5-2.6b:free` (mandatory reasoning) spent its 600-token budget on reasoning and returned no content (section 2.3). Lyria accepts `response_format` JSON "without JSON-schema enforcement" **[doc]** (model page). Source: https://openrouter.ai/docs/guides/features/structured-outputs

### 2.7 Reasoning **[doc]**

```json
{
  "reasoning": {
    "effort": "high",
    "max_tokens": 2000,
    "exclude": false,
    "enabled": true
  }
}
```

Set **either** `effort` (`max|xhigh|high|medium|low|minimal|none`) **or** `max_tokens`, not both. `exclude: true` hides reasoning from the response but it is still billed and still counts against `max_tokens`. Legacy `include_reasoning: true|false` maps to `reasoning:{}` / `{exclude:true}`. The OpenAPI schema for `reasoning` lists only `effort` and `summary(auto|concise|detailed)`; the guide is richer, so follow the guide.

Response: `message.reasoning` (string) and `message.reasoning_details[]` (`{type:"reasoning.summary"|"reasoning.text"|"reasoning.encrypted", ..., id, format, index}`); stream: `delta.reasoning` / `delta.reasoning_details`. A reasoning model can spend the whole `max_tokens` on reasoning and return 200 with `finish_reason:"length"` and empty `content`.

**[probed]** Sending `reasoning:{effort:"none"}` to a model whose catalog entry has `reasoning.mandatory:true` (`liquid/lfm-2.5-2.6b:free`) returns `400 {"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400,"metadata":{"provider_name":null}}}` (`error-400-reasoning-mandatory.recorded.json`), confirming the catalog flag is enforced. `reasoning:{effort:"low"}` on `nvidia/nemotron-3-super-120b-a12b:free` was accepted (200).

Per-model options come from the catalog's `reasoning` object: `{supported_efforts[] | null, default_effort, default_enabled, mandatory, supports_max_tokens?}`; absent for non-reasoning models and routers. `mandatory: true` means do not send `effort:"none"`. Source: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens

### 2.8 Model fallbacks (`models`) **[doc]**

```json
{
  "models": ["~anthropic/claude-sonnet-latest", "gryphe/mythomax-l2-13b"],
  "messages": [{ "role": "user", "content": "What is the meaning of life?" }]
}
```

Tried in order on any error (context-length validation, moderation, rate limit, downtime). Billing uses the model that finally served the request, reported in the response `model`. Source: https://openrouter.ai/docs/guides/routing/model-fallbacks

### 2.9 Provider routing (`provider`) and data retention **[doc]**

Fields: `order[]`, `only[]`, `ignore[]`, `allow_fallbacks` (default true), `require_parameters`, **`data_collection: "allow"|"deny"`** (default `allow`), **`zdr: boolean`**, `enforce_distillable_text`, `quantizations[]`, `sort` (`price|throughput|latency|exacto` or `{by, partition}`), `preferred_min_throughput`, `preferred_max_latency`, `max_price{prompt,completion,image,audio,request}`, `options{<provider-slug>:{...}}`.

* "Prefer providers that do not retain data" = `provider.data_collection: "deny"` (only providers that do not collect user data; the request errors if none qualifies). The stricter option is `provider.zdr: true` (only Zero Data Retention endpoints). Account-wide equivalents are set in OpenRouter's privacy settings, not via API.
* `zdr` ORs with account/guardrail settings; a request cannot weaken them. It covers inference routing only, not plugins/tools.

```json
{ "provider": { "data_collection": "deny" } }
```

(Built from the field table; the docs' code samples use the same field.) **[probed]** With a `:free` text model this returns **404** `{"error":{"message":"No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy","code":404,"metadata":{"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":1}],"failed_routing_step":"Filter by Data Policy"}}}` (`error-404-data-policy.recorded.json`). Free models are served under a training-allowed policy, so `data_collection:"deny"` and free-only mode are mutually exclusive; surface that conflict in Settings instead of failing at run time. `provider.require_parameters:true` was accepted on a structured-output request (section 2.6).

* Availability per capability, `GET /models?zdr=true&output_modalities=<x>` **[probed]**: text 331 of 466; speech 16 of 23; transcription 16 of 24; image 17 of 59; decisions 5 of 10; **video 0** (video is not ZDR-eligible, and a ZDR guardrail blocks video models); Lyria/audio-output 0. `GET /endpoints/zdr` (keyless) lists 929 ZDR endpoints.
* Support on dedicated endpoints: TTS and STT accept `provider.zdr` and `provider.data_collection` (but not `order/only/ignore`). Decisions accepts the full `ProviderPreferences`. **`/images` accepts only `only, order, ignore, sort, allow_fallbacks, options`: no `data_collection`/`zdr` in its schema.** **[doc]**

Sources: https://openrouter.ai/docs/guides/routing/provider-selection, https://openrouter.ai/docs/guides/features/zdr

---

## 3. Image generation and editing

Source: https://openrouter.ai/docs/guides/overview/multimodal/image-generation, https://openrouter.ai/docs/api/api-reference/images/generate-an-image, https://openrouter.ai/docs/api/api-reference/images/list-image-generation-models, https://openrouter.ai/docs/api/api-reference/images/list-endpoints-for-an-image-model

### 3.1 Endpoints

| Method + path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/images` | key | Generate / edit. **[doc]** [probed: preflight 204, unauthenticated POST 401 with `access-control-allow-origin: *`] |
| `GET /api/v1/images/models` | none **[probed]** | 57 image models with `supported_parameters` descriptors. |
| `GET /api/v1/images/models/{author}/{slug}/endpoints` | none **[probed]** | Per-provider capabilities, pricing, passthrough options. |

Chat-route image output also exists: `modalities: ["image","text"]` on `/chat/completions` for models whose `architecture.output_modalities` contains `image` plus `text` (11 today, e.g. `google/gemini-3.1-flash-image`, `openai/gpt-5-image`). The response puts images at `choices[0].message.images[].image_url.url` ("URL or base64-encoded data of the generated image"). **[doc: spec only]** The prose docs no longer describe this route or the `image_config` keys. Use `/images` unless a model is chat-only. **[probed]** a chat-route request (`google/gemini-3.1-flash-lite-image`, `modalities:["image","text"]`, `image_config:{"aspect_ratio":"1:1"}`) was refused before any generation with **`402 {"error":{"message":"This request requires at least $1.00 in balance for image or video output","code":402,"metadata":{"limit_source":"openrouter_key_limit","remedy_hint":"Raise or remove this API key's usage limit ..."}}}`** (not billed; `error-402-chat-image-balance.recorded.json`). The key's remaining limit was about $0.57 (a $1.00 limit with about $0.43 spent), and the same key had just run `/images` and `/videos` jobs successfully, so the **$1.00 minimum applies to the chat route** and counts the key's own limit. The real `message.images` shape and `image_config` keys stay **[unverified]**. Fixture: `chat-completion-image-output.documented.json`.

### 3.2 Request body (`ImageGenerationRequest`) **[doc]**

| Field | Type / values |
| --- | --- |
| `model`* | string, e.g. `bytedance-seed/seedream-4.5` |
| `prompt`* | string, min length 1 |
| `n` | integer 1-10, an upper bound; single-image providers reject `n>1` |
| `aspect_ratio` | enum `1:1 1:2 1:4 1:8 2:1 2:3 2.35:1 3:2 3:4 4:1 4:3 4:5 5:2 5:4 5:7 7:5 8:1 9:16 16:9 9:19.5 19.5:9 9:20 20:9 9:21 21:9 auto`; providers clamp to their subset |
| `resolution` | enum `512 768 1K 1.5K 2K 4K` |
| `size` | string; tier (`"2K"`) or explicit pixels (`"2048x2048"`). Explicit pixels are authoritative; a mismatched `resolution`/`aspect_ratio` gives 400 |
| `quality` | enum `auto low medium high xhigh max` (the guide lists only `auto low medium high`) |
| `output_format` | enum `png jpeg webp svg` (`svg` for vectorizing models; UTF-8 SVG markup base64-encoded in `b64_json`) |
| `background` | enum `auto transparent opaque` (`transparent` needs png/webp) |
| `output_compression` | integer 0-100 for webp/jpeg |
| `seed` | integer |
| `stream` | boolean; only providers with native streaming (OpenAI); others return a buffered response |
| `input_references` | array of `{type:"image_url", image_url:{url}}`, **https URLs or base64 data URLs** |
| `provider` | `only, order, ignore, sort, allow_fallbacks, options{<slug>:{...}}` |
| `user`, `session_id`, `trace` | as elsewhere |

Always read the model's `supported_parameters` (keyless): each key is a field name, the value a descriptor `{type:"enum",values[]}` | `{type:"range",min,max}` | `{type:"boolean"}`. An absent key means unsupported. `input_references` is a `range` giving the allowed reference-image count (e.g. gpt-image-2 0-16, Gemini 3.1 Flash Image 0-14, FLUX.2 Pro 0-8, many Recraft/ming models min 1). `size` is supported by only 2 of 57 models today. **[probed]** `openai/gpt-image-2` offers `background: auto|opaque` only (no `transparent`) and `supports_streaming: true`. **[probed]**

### 3.3 Editing and masks

* Editing = `prompt` + one or more `input_references`. The model decides what to change.
* **No mask, inpaint or outpaint field exists** (spec and docs searched). To approximate a masked edit, send the image with the region marked up (or send the mask as a second reference) and describe it in the prompt. Results are generative and unconstrained outside the marked region, so the deterministic browser post-processing in PLAN's Isolated image tool remains necessary.
* Models with `input_references.min >= 1` are reference-only editors (e.g. `recraft/recraft-v4-styles*`, `inclusionai/ming-image-0.1-design-layer`).

### 3.4 Response **[doc]**

Non-streaming (verbatim):

```json
{
  "created": 1748372400,
  "data": [
    {
      "b64_json": "<base64-encoded-image>",
      "media_type": "image/png"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 4175,
    "total_tokens": 4175,
    "cost": 0.04
  }
}
```

`media_type` is omitted when the format could not be determined. Cost is `usage.cost`. Billing is **all-or-nothing**: a failed or cancelled generation returns an error (docs say `502`) and is not billed; a client disconnect does not avoid upstream work but still bills only completed images.

Streaming (`stream:true`, OpenAI models only): SSE events (verbatim):

```text
data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"<base64>"}
data: {"type":"image_generation.completed","b64_json":"<base64>","media_type":"image/png","created":1748372400,"usage":{"prompt_tokens":16,"completion_tokens":272,"total_tokens":288,"cost":0.011}}
data: {"type":"error","error":{"message":"Generation failed","code":"server_error"}}
data: [DONE]
```

A fourth event type `image_generation.text_chunk` (`{phase:"content"|"reasoning"|"draft", text}`) exists for text-based formats (SVG). Fixtures: `images-generate.documented.json`, `images-stream.documented.json`, `images-stream-error.documented.json`.

**[probed] real `/images` calls** (CORS headers `Access-Control-Allow-Origin: *`, `X-Generation-Id: gen-img-<unix>-<20 chars>`, `X-Provider-Name`; fixtures `images-generate.recorded.json`, `images-edit.recorded.json`, `images-stream.recorded.sse.txt`; base64 truncated):

| Call | Result |
| --- | --- |
| `black-forest-labs/flux.2-klein-4b`, `{prompt, aspect_ratio:"1:1", n:1}` | 200 in 4.3 s. Body `{created: 0, data:[{b64_json, media_type:"image/jpeg"}], usage:{prompt_tokens:19, completion_tokens:4096, total_tokens:4115, cost:0.014, is_byok:false, prompt_tokens_details, cost_details{upstream_inference_cost, ...}, completion_tokens_details{image_tokens:4096}}}`. **`created` is `0`** (do not use it), there is **no `id` in the body** (the id is only the `X-Generation-Id` header), and `media_type` was **`image/jpeg` although no `output_format` was sent** (the model default; flux klein supports `output_format: png|jpeg`). Output was 1024x1024, 69,625 bytes (`tests/fixtures/media/generated-image.jpg`). Cost $0.014 for the 1024x1024 output (catalog price $0.014/megapixel). |
| Same model with `input_references:[{type:"image_url", image_url:{url:"data:image/jpeg;base64,..."}}]` + edit instruction | 200 in 4.7 s, JPEG 1024x1024 (105,165 bytes, `edited-image.jpg`), `usage.prompt_tokens: 4096` (the input image is counted as 4096 tokens), cost **$0.015**. **Base64 data URLs are accepted for `/images` references.** |
| `openai/gpt-image-1-mini`, `{quality:"low", aspect_ratio:"1:1", stream:true}` | 200, `text/event-stream`, 6.8 s, 3.0 MB. Framing is LF only. The stream began with **7 empty comment lines (`: ` colon + space, not `: OPENROUTER PROCESSING`)**, then one `image_generation.partial_image` event (`partial_image_index:0`, 1.73 M base64 chars), 8 more `: ` lines, then `image_generation.completed` (`b64_json` 1.31 M chars, `media_type:"image/png"`, `created` set, `usage{completion_tokens:372, cost:0.003006, ...}`) and `data: [DONE]`. Both images were PNGs carrying a C2PA manifest (starts `iVBORw0K...` then `jumb`/`c2pa`). Only one partial arrived at `quality:"low"`. A parser must tolerate `:` comment lines with no text. |
| `n:5` on klein; `aspect_ratio:"21:9"` on gpt-image-1-mini | Free 400s: `No provider for black-forest-labs/flux.2-klein-4b supports the requested parameter(s): n "5". Provider rejections: Black Forest Labs: n: must be exactly 1` and `... aspect_ratio "21:9". Provider rejections: OpenAI: aspect_ratio: not supported. Accepted: 1:1, 3:2, 2:3, auto`, with `metadata.routing_funnel` / `failed_routing_step:"Filter by Image Capabilities"`. The accepted values are listed in the message, so surface it. |

### 3.5 Catalog and pricing

`GET /images/models` (`data[]` of `{id, name, description, created, architecture{input_modalities, output_modalities}, supported_parameters, supports_streaming, endpoints}`) **[probed]**; per-endpoint pricing is an array `{billable: output_image|input_image|input_reference|input_text|input_font, unit: image|megapixel|token|request, cost_usd, variant?}` (e.g. seedream-4.5 $0.04/image; FLUX.2 Pro $0.03/megapixel; gpt-image-2 token-priced) **[probed]**. Units differ per model, so a pre-run estimate needs per-unit handling; the real cost is `usage.cost`. `/models?output_modalities=image` returns 59 entries: the 57 above plus `openrouter/auto` and `openrouter/auto-beta` **[probed]**. Catalog per-image and per-megapixel prices matched the billed `usage.cost` in the probes above (klein $0.014 for a 1024x1024 output, gpt-image-1-mini $0.003006 at `quality:"low"`); adding one 1024x1024 reference image to the edit added $0.001 (billed $0.015). Cheapest per-image/megapixel models today (endpoint pricing): `recraft/recraft-v4.1-flash` $0.007/image, `black-forest-labs/flux.2-klein-4b` $0.014/MP, `bytedance-seed/seedream-5-0-flash` $0.018/image. Fixtures: `images-models.json` (15 of 57), `images-model-endpoints.*.json`.

---

## 4. Text-to-speech

`POST https://openrouter.ai/api/v1/audio/speech` **[doc]**. Source: https://openrouter.ai/docs/guides/overview/multimodal/tts, https://openrouter.ai/docs/api/api-reference/tts/create-speech

CORS **[probed]**: preflight 204 with `access-control-allow-origin: *`. With an invalid body the route returns a **400 ZodError before auth** (see section 12); with a valid body and no key it returns 401.

### 4.1 Request body (JSON) **[doc]**

| Field | Type / notes |
| --- | --- |
| `model`* | string, a model from `GET /models?output_modalities=speech` |
| `input`* | string to synthesize. Some models (Seed Audio 1.0) treat it as a prompt that can also describe non-speech audio. |
| `voice` | string. "Provider-dependent": omit only when the provider documents a default; otherwise an explicit voice is required (omitting it where unsupported is a validation error). |
| `response_format` | **`mp3` or `pcm`** (default `pcm`). `pcm` is raw 16-bit little-endian; Azure MAI-Voice PCM is 24 kHz mono **[doc]**. **[probed]** the response `Content-Type` carries the parameters: `audio/pcm;rate=44100;channels=1` (Fish Audio), `audio/pcm;rate=24000;channels=1` (Kokoro, Gemini TTS); read `rate`/`channels` from the header. **Not every model supports both formats: `google/gemini-3.8-flash-tts` rejects `mp3` with a free 400 `Gemini TTS only supports response_format="pcm". Got "mp3".`** The spec description mentions `wav` in prose but the enum is only `mp3 \| pcm`. |
| `speed` | number, default 1.0. Honoured by some models (OpenAI-style); others ignore it or 400 on a non-default value. Seed Audio: 0.5-2.0. |
| `input_references` | voice cloning / voice design: 1-3 `{type:"input_audio", input_audio:{data \| url}}` (optionally each followed by `{type:"text", text:<transcript>}`), **or** exactly one `{type:"image_url", image_url:{url}}`. Never both kinds. Limits: 15 MiB decoded per inline clip (20 MiB base64), transcript <=10,000 chars, URLs <=2048 chars. Only routed to endpoints with `supports_voice_cloning` / `supports_multiple_audio_references` / `supports_image_reference` (per-endpoint flags). `@Audio1..@Audio3` placeholders in `input` address multiple clips (Seed Audio 1.0 only). |
| `provider` | `zdr`, `data_collection`, and `options{<slug>:{...}}`; `order/only/ignore` are not applied. Examples: OpenAI `options.openai.instructions`; Google `options.google-ai-studio.speech_metadata.style`. |
| `user`, `session_id`, `trace` | as elsewhere |

Verbatim request:

```json
{
  "model": "mistralai/voxtral-mini-tts-2603",
  "input": "Hello world",
  "voice": "en_paul_neutral",
  "response_format": "pcm",
  "speed": 1
}
```

(Spec example. The guide uses `openai/gpt-4o-mini-tts-2025-12-15` with `voice: "alloy"`, which is not in today's catalog.)

### 4.2 Voices **[probed]**

There is **no voices-list endpoint**. Voices are the catalog field `supported_voices` (`string[]` or `null`) on `GET /models?output_modalities=speech` entries (and `/models`). Today 18 of 23 TTS models list voices (e.g. Gemini TTS 30 names such as `Zephyr`, `Puck`, `Charon`, `Kore`; Kokoro 54 ids like `af_alloy`; MAI-Voice 97 ids like `en-US-Harper:MAI-Voice-2.1`; Deepgram Aura-2 `aura-2-thalia-en`; Qwen TTS `loongjohn`). Models with `null` (Fish Audio x4, Seed Audio: 5 of 23) list no voices: `voice` is optional, a provider-specific id (Seed Audio accepts a Seed speaker id), or replaced by `input_references`. **[probed]** `fish-audio/s2.1-pro-free:free` synthesized fine with **no `voice`** field, but `hexgrad/kokoro-82m` without `voice` returned a free 400 `An explicit voice is required for this TTS provider.`; with `voice:"af_alloy"` (from its `supported_voices`) it worked, and Gemini TTS accepted `voice:"Kore"`. **`openai/whisper-1` (an STT model) has `supported_voices: []`**, so check `Array.isArray && length` rather than truthiness. No voice preview/sample audio is exposed by the API; previews require a synthesis request per voice.

### 4.3 Response **[doc]**

**Raw audio bytes, not JSON.** Headers: `Content-Type` and `X-Generation-Id` (docs list `audio/mpeg` for mp3 and `audio/pcm` for pcm). Non-200 responses are JSON error bodies. There is no SSE and no `stream` field. **[probed]** with the free model `fish-audio/s2.1-pro-free:free` (`input: "Hello from the toolbox."`, no `voice`): both formats returned `200` with `Transfer-Encoding: chunked`, `Access-Control-Allow-Origin: *`, `X-Generation-Id: gen-tts-<unix>-<20 chars>` (note the `gen-tts-` prefix), and:

| `response_format` | `Content-Type` | Body |
| --- | --- | --- |
| `mp3` | `audio/mpeg` | 29,256 bytes starting `ff fb 90 c4` (no ID3 tag): MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono |
| omitted (= `pcm`) | `audio/pcm;rate=44100;channels=1` | 126,976 bytes, headerless s16le (about 1.44 s of audio at that rate) |

Fixtures `audio-speech-mp3.recorded.json` and `audio-speech-pcm.recorded.json` store the request, headers, byte count and first bytes (the audio itself is not stored). `audio-speech-response.documented.json` is the earlier shape-only fixture.

* **Cost:** not in the response body or headers (only `X-Generation-Id: gen-tts-...` and, for some providers, `X-Provider-Name`). **[probed]** `GET /generation?id=<X-Generation-Id>` returned the cost: 404 at 1.3 minutes, 200 at 5.7 minutes with `{api_type:"tts", total_cost, usage, tokens_prompt, provider_name, model (dated snapshot)}`. Real costs: `hexgrad/kokoro-82m` 44 characters = **$0.000176** (`tokens_prompt: 11`; routed to Together at $4/M characters, whereas `/models` and DeepInfra say $0.62/M), `google/gemini-3.8-flash-tts` "The quick brown fox." = **$0.00057** (`tokens_prompt: 5`, `tokens_completion: 63` audio tokens). So **the catalog price is a lower bound**; budget with the most expensive endpoint from `GET /models/{id}/endpoints` and reconcile from `/generation` later (fixtures `generation-tts.recorded.json`, `audio-speech-*.recorded.json`).
* **[probed] outputs:** Kokoro `mp3` for 44 chars: 13,197 bytes, MP3 24 kHz mono 32 kbps, 3.24 s (`tests/fixtures/media/speech.mp3`); Kokoro `pcm` for "The quick brown fox." = 91,338 bytes (1.9 s at 24 kHz); Gemini `pcm` = 94,080 bytes (1.96 s at 24 kHz).
* **Pricing units are not machine-readable.** `/models` gives one number in `pricing.prompt`/`pricing.completion` and the unit depends on the model **[probed via model pages]**: most TTS per character (`$15/M characters`), Fish Audio per **UTF-8 byte**, Gemini TTS per token (`prompt` and `completion` both used), Seed Audio per second of output (`completion` field, `$0.15/minute` on the page). Estimates must special-case by model family.
* **Limits:** Seed Audio 1.0: `input` <=3000 chars, <=120 s of output. Other models' maximum input length is **[unverified]** (catalog `context_length` is tokens, 4096 for Kokoro/Orpheus/Sesame/Voxtral TTS, 15000 for Grok TTS, 32768 for Gemini TTS, 0 for many). The docs advise chunking long text and concatenating audio.

### 4.4 Free TTS

`fish-audio/s2.1-pro-free:free` is the only free speech model today and is subject to the free-model limits (section 12). **[probed]** Paid TTS models were probed too (Kokoro, Gemini TTS; sections 4.1 to 4.3).

---

## 5. Speech-to-text

`POST https://openrouter.ai/api/v1/audio/transcriptions` **[doc]**. Source: https://openrouter.ai/docs/guides/overview/multimodal/stt, https://openrouter.ai/docs/api/api-reference/stt/create-transcription

CORS **[probed]**: preflight 204, unauthenticated POST 401 with `access-control-allow-origin: *`.

### 5.1 Request: JSON (base64) or multipart **[doc]**

JSON body (`application/json`):

| Field | Type / notes |
| --- | --- |
| `model`* | string, from `GET /models?output_modalities=transcription` |
| `input_audio`* | `{data:<base64 raw bytes, NOT a data URI>, format:<string>}` **or** `{url:<public http(s) URL, <=8000 chars>, format?}` (URL only on some providers; the provider downloads it). `format` pattern `^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,15}$`, e.g. `wav mp3 flac m4a ogg webm aac`. `pcm` means headerless signed 16-bit little-endian mono at 16 kHz. |
| `language` | ISO-639-1; auto-detect when omitted |
| `temperature` | number 0-1 |
| `response_format` | `json` (default; returns `{text, usage}`) or `verbose_json`. **`text`, `srt`, `vtt` are rejected with 400**, so build SRT/VTT client-side from `segments`/`words`. Some models reject `verbose_json` (the docs name `openai/gpt-4o-transcribe` and `microsoft/mai-transcribe-1.5`). |
| `timestamp_granularities` | `["segment"]` and/or `["word"]`; only with `verbose_json` |
| `diarize` | boolean. **[probed] Rejected with 400 `The selected model does not support diarize. Remove the field or choose a model whose provider supports it.` on `openai/whisper-large-v3-turbo`, `x-ai/grok-stt-1.0`, `microsoft/mai-transcribe-2` and `deepgram/nova-3`; use `provider.options` (works, see 5.4).** **Spec:** top-level; labels each word (`words[].speaker`, `words[].speaker_label`); requires `verbose_json` (400 otherwise); word timestamps are implied; 400 if the model cannot diarize. **Guide** (older wording): enable via `provider.options.<slug>`, e.g. `{"azure":{"diarization":{"enabled":true}}}` or Deepgram `diarize`. Both are documented (the spec is more detailed; which is newer is not stated). Which models support it is not machine-readable (model pages mention Gemini 3.5 Transcribe, MAI-Transcribe 2, Grok STT, Fish Transcribe 1 Pro). No model honouring the top-level field was found among the four tried. |
| `keyterms` | `string[]` (each 1-100 chars), vocabulary bias; 400 if unsupported |
| `provider` | `zdr`, `data_collection`, `options{<slug>:{...}}` |
| `user`, `session_id`, `trace` | as elsewhere |

Multipart (`multipart/form-data`, OpenAI-compatible) fields: `file` (or `source_url`; exactly one), `model`, `language`, `temperature`, `response_format`, `timestamp_granularities[]`, `diarize`, `keyterms[]`, `provider` (JSON string), `trace` (JSON string), `user`, `session_id`. `prompt` is accepted but ignored.

Verbatim JSON request (cURL form from the guide):

```json
{
  "model": "microsoft/mai-transcribe-2",
  "input_audio": { "data": "<base64>", "format": "mp3" },
  "response_format": "verbose_json",
  "timestamp_granularities": ["segment", "word"],
  "provider": { "options": { "azure": { "diarization": { "enabled": true } } } }
}
```

### 5.2 Limits **[doc]**

* Multipart: **25 MB**. Base64 JSON larger than that is accepted only for **OpenAI and Groq** models (large body offloaded); other providers reject it.
* Upstream providers time out after **60 s** per request: split long recordings. The tool's chunking plan (continuous timestamps) must add each chunk's offset to `start`/`end`.
* Per-model caps appear only in model descriptions (**[probed]** from model pages): Gemini 3.5 Transcribe up to 1 h, or 30 min with timestamps or diarization (up to 8 speakers); AssemblyAI Universal-3.5 Pro up to 120 s; Meta Muse Voice Transcribe 10 min of mono 16-bit PCM WAV at 16 or 24 kHz; Whisper-1 25 MB. No machine-readable field.

### 5.3 Response **[doc]**

`json` (verbatim):

```json
{
  "text": "Hello, this is a test of speech-to-text transcription.",
  "usage": {
    "seconds": 9.2,
    "total_tokens": 113,
    "input_tokens": 83,
    "output_tokens": 30,
    "cost": 0.000508
  }
}
```

`verbose_json` adds `task`, `language`, `language_confidence`, `duration`, `confidence`, `segments[]` (`{id, start, end, text, speaker?, speaker_label?, avg_logprob?, no_speech_prob?, tokens?, channel?}`), `words[]` (`{word, start, end, speaker?, speaker_label?, confidence?, type?:"word"|"audio_event", channel?}`), `entities[]`. Which fields appear varies by provider. Speaker labels appear on segments, words or both depending on the provider. Verbatim abridged example:

```json
{
  "language": "en",
  "duration": 6.4,
  "text": "Hello there. Hi, how are you?",
  "segments": [
    { "id": 0, "start": 0.0, "end": 1.2, "text": "Hello there.", "speaker": 0 },
    { "id": 1, "start": 1.5, "end": 3.1, "text": "Hi, how are you?", "speaker": 1 }
  ],
  "words": [
    { "word": "Hello", "start": 0.0, "end": 0.4, "speaker": 0 },
    { "word": "there.", "start": 0.4, "end": 1.2, "speaker": 0 }
  ],
  "usage": { "seconds": 6.4, "cost": 0.000178 }
}
```

Cost is `usage.cost` in the body. Header `X-Generation-Id` is also returned. Fixtures: `audio-transcriptions.documented.json`, `audio-transcriptions-verbose.documented.json`.

### 5.4 Probed results (paid round; `tests/fixtures/openrouter/audio-transcriptions-*.recorded.json`)

A 3.24 s Kokoro MP3 ("The quick brown fox jumps over the lazy dog.") was transcribed with several request forms. All CORS headers as elsewhere; `X-Generation-Id: gen-stt-<unix>-<20 chars>`.

| Request | Result |
| --- | --- |
| JSON `input_audio:{data:<base64 raw bytes>, format:"mp3"}` on `openai/whisper-large-v3-turbo`, default format | 200 `{"text":" The quick brown fox jumps over the lazy dog.","usage":{"seconds":3.17,"cost":0.0000105561}}` (note the **leading space** in `text`). |
| Same + `response_format:"verbose_json"`, `timestamp_granularities:["segment","word"]`, `language:"en"` | 200 with `task:"transcribe"`, `language:"en"`, `duration:3.17`, `segments[]` (`id, seek, start, end, text, tokens[], temperature, avg_logprob, compression_ratio, no_speech_prob`) and `words[]` (`word` with leading space, `start`, `end`; floats like `0.11999999731779099`). |
| Multipart `-F file=@speech.mp3 -F model=... -F response_format=verbose_json -F timestamp_granularities[]=word -F timestamp_granularities[]=segment` | 200, the same verbose shape and cost (OpenAI-compatible multipart works; no `Content-Type` header to set manually with `FormData`). |
| `response_format:"srt"` (multipart) | Free 400 `Unsupported response_format "srt". Only "json" and "verbose_json" are supported.` Generate SRT/VTT yourself. |
| `x-ai/grok-stt-1.0`, JSON | 200, `text` without leading space, `usage:{seconds:3.24, cost:0.00009}`. |
| `deepgram/nova-3`, `verbose_json`, `timestamp_granularities:["word","segment"]`, `provider:{options:{deepgram:{diarize:true}}}` | 200: `{text, usage{seconds:3.2399375, cost:0.000232195}, duration, segments:[{id,start,end,text,speaker:0}], words:[{word,start,end,speaker:0}]}` (no `task`/`language`; words have no leading space). |
| `microsoft/mai-transcribe-2`, same with `provider:{options:{azure:{diarization:{enabled:true}}}}` | 200: `language:"en"`, `duration:3.17`, segments/words with `speaker:0`; **`usage.seconds` was `4` for 3.17 s of audio and cost `0.000111`, i.e. billed in whole seconds, rounded up** ($0.10/hour x 4 s). Whisper billed 3.17 s fractionally. |

`GET /generation` for STT ids returns `api_type:"stt"` and `total_cost` equal to `usage.cost` once indexed (`generation-stt.recorded.json`). `usage.cost` in the body is authoritative; no estimate is needed after the fact.

**Pricing units** vary and are not in the API **[probed via model pages]**: most STT models per second of audio (`pricing.prompt`, e.g. `openai/whisper-1` `$0.0001/second`); Microsoft MAI-Transcribe per **hour** (`pricing.prompt` is `0.1` and `0.36`); Gemini Transcribe and `openai/gpt-4o-*-transcribe` per token (prompt and completion). There is no free STT model today.

---

## 6. Music (Lyria 3 via chat completions)

### 6.1 Models **[probed]**

| id | name | modality | context / max out | catalog `pricing` | stated price |
| --- | --- | --- | --- | --- | --- |
| `google/lyria-3-pro-preview` | Google: Lyria 3 Pro Preview | `text+image->text+audio` | 1,048,576 / 65,536 | `prompt:"0", completion:"0"` | "$0.08 per song" (description; model page `$0.08 /song`) |
| `google/lyria-3-clip-preview` | Google: Lyria 3 Clip Preview | `text+image->text+audio` | 1,048,576 / 65,536 | `"0" / "0"` | "30 second duration clips are priced at $0.04 per clip" |

* Single provider (Google AI Studio). `supported_parameters`: `max_tokens, response_format, seed, temperature, top_p` (no `audio`, `reasoning`, tools). Inputs: text and image. Descriptions: "48kHz stereo audio", "vocals, timed lyrics, and full instrumental arrangements"; Pro makes "full-length songs with verses, choruses, bridges", Clip makes "short clips, loops, previews".
* There is **no `music` output modality**. `GET /models?output_modalities=music` returns 400 (valid values: `text, image, embeddings, audio, video, rerank, decisions, speech, transcription, all`). `output_modalities=audio` returns 4 models: the 2 Lyria models plus `openai/gpt-audio` and `openai/gpt-audio-mini` (speech chat models). Identify Lyria by id prefix `google/lyria-`.
* Model-level fixture: `model-endpoints.google-lyria-3-pro-preview.json` (endpoint flags include `supports_image_reference: false`, a TTS-oriented flag that does not gate chat input: Lyria accepted an `image_url` part anyway, section 6.2).

### 6.2 Request and stream shape **[probed]** (Lyria) and **[doc]** (generic audio output)

**[probed] Lyria 3 Clip, minimal working request** (no `audio` object; fixtures `music-lyria-clip-request.recorded.json`, `music-lyria-clip.recorded.sse.txt`):

```json
{
  "model": "google/lyria-3-clip-preview",
  "messages": [{ "role": "user", "content": "Write a short 10 second upbeat pop jingle with female vocals singing these lyrics.\n[Verse]\nHello world, hello day\nSunshine on the way\n[Chorus]\nLa la la, we sing along\nThis is our little song" }],
  "modalities": ["text", "audio"],
  "stream": true
}
```

Response `200 text/event-stream` (10.8 s, LF framing, `X-Generation-Id`, CORS `*`). Event sequence, in order:

1. **17 `: OPENROUTER PROCESSING` comment lines** arrive first (one about every 0.6 s) while the model works; then
2. chunk 0: `choices[0].delta = {role:"assistant", content:"[0.0:3.7] HELLO WORLD, HELLO DAY\n[3.8:7.4] SUNSHINE ON THE WAY\n..."}` (the timed lyrics, `provider:"Google AI Studio"`, `native_finish_reason: null`);
3. chunk 1: `delta = {role:"assistant", content:"", audio:{data:"<ONE base64 string, 992,816 chars>"}}`. **The whole file is a single chunk; there is no `transcript` and no `id`/`expires_at`.** Field path: `choices[0].delta.audio.data`;
4. chunk 2 and chunk 3: `finish_reason:"stop"` (twice, the second carries `usage`), then `data: [DONE]`.

`usage` on the last chunk: `{prompt_tokens:49, completion_tokens:71, total_tokens:120, cost:0.04, is_byok:false, cost_details{upstream_inference_cost:0.04,...}, completion_tokens_details{audio_tokens:71}}`. `GET /generation` later reports `api_type:"completions"`, `streamed:true`, `total_cost:0.04`.

**Decoded audio:** the base64 decodes to **MP3**, 744,610 bytes, **44.1 kHz stereo, 192 kbps, 30.77 s**, starting `ID3\x03\x00` (an ID3v2.3 tag of about 6 KB holding a `GEOB application/c2pa` Google C2PA content-credentials manifest, then MPEG frames). Not WAV, not Ogg. An `<audio>` element or `decodeAudioData` plays it directly; strip or ignore the ID3 tag if you re-mux.

**Other probed variants:**

| Variant | Result |
| --- | --- |
| Clip with `[{type:"text"}, {type:"image_url", data URL PNG}]` content, `audio:{format:"wav"}`, prompt "Instrumental only, no vocals" | 200, $0.04. **Image accepted; `audio.format:"wav"` accepted but ignored** (still `ID3` + MP3, 744,930 bytes). `delta.content` was `<instrumental>`. (`music-lyria-clip-image-wav.recorded.sse.txt`) |
| **Lyria 3 Pro**, lyrics with `[Verse]`/`[Chorus]` tags, no `audio` | 200 in **43.1 s**, `usage.cost: 0.08`, **76 keep-alive comments**, stream 5.78 MB, one audio chunk (5.77 M base64 chars) = **MP3 44.1 kHz stereo 192 kbps, 180.11 s, 4,328,819 bytes**. `delta.content` held the whole structure and timed lyrics: `[[A0]]`, `[[B1]]`, `[12.0:] Morning light on the quiet hill`, ... with sections `[[A0]]..[[D3]]`, repeated choruses and an invented second verse. (`music-lyria-pro.recorded.sse.txt`) |

**Duration is not controllable.** The Clip prompt asked for 10 seconds and returned 30.77 s of audio (and timestamps to 29.9 s); Pro returned a full 3-minute song from a two-line prompt. Plan the UI around fixed lengths (about 30 s and about 3 min) and let users trim in the browser.

**Memory:** a Pro stream is 5.8 MB of JSON text; accumulate the one chunk, `atob` it (about 4.3 MB) and discard the SSE text.

**Generic audio-output contract from the docs (other models, e.g. speech-chat):** Source: https://openrouter.ai/docs/guides/overview/multimodal/audio. For models with audio output:

```json
{
  "model": "openai/gpt-4o-audio-preview",
  "messages": [{ "role": "user", "content": "Say hello in a friendly tone." }],
  "modalities": ["text", "audio"],
  "audio": { "voice": "alloy", "format": "wav" },
  "stream": true
}
```

* **Streaming is mandatory** for audio output ("Audio output requires streaming").
* Chunks carry `choices[0].delta.audio` with **base64** `data` fragments and optional `transcript` text. Concatenate all `data` strings (then decode once; the guide joins the base64 strings before decoding) to get the file. Verbatim shape:

```json
{
  "choices": [
    {
      "delta": {
        "audio": {
          "data": "<base64-encoded audio chunk>",
          "transcript": "Hello"
        }
      }
    }
  ]
}
```

* `audio.voice` and `audio.format` (`wav, mp3, flac, opus, pcm16`; "vary by model") are documented for speech-chat models. The final `usage` chunk and `[DONE]` follow as in 2.3. Fixture: `chat-stream-audio.documented.json` (**generic shape, not a Lyria capture**).

### 6.3 Remaining unknowns for music

* `usage.cost` for Lyria is the **flat** $0.04 / $0.08 (confirmed on both). The catalog `pricing` of `"0"` is meaningless for these models.
* Whether `seed`, `temperature`, `top_p` change the result or whether a lyrics-only prompt can force a given length is untested (nothing in the probes suggests a length control).
* The maximum number of reference images and how strongly they steer the song: one image was accepted and the text transcript was `<instrumental>`; the effect cannot be judged without listening.
* Whether longer/other Pro prompts ever split the audio into several chunks (both Pro and Clip sent exactly one).

---

## 7. Video generation

Source: https://openrouter.ai/docs/guides/overview/multimodal/video-generation, https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request (and `poll-`, `download-`, `list-all-video-generation-models`), https://openrouter.ai/docs/cookbook/video-generation/text-to-video

### 7.1 Endpoints **[doc]**

| Method + path | Auth | Notes |
| --- | --- | --- |
| `GET /api/v1/videos/models` | **none** **[probed]** (200, 30 models, `Access-Control-Allow-Origin: *`) | Capabilities and pricing. |
| `POST /api/v1/videos` | key | Submit; **202**. |
| `GET /api/v1/videos/{jobId}` | key | Poll. |
| `GET /api/v1/videos/{jobId}/content?index=0` | key | Bytes. `index` defaults to 0. |

All four have CORS preflight 204 with `allow-origin: *`; the three authenticated routes return 401 with the CORS header when no key is sent **[probed]**. There is no cancel/delete endpoint in the spec. A `callback_url` webhook exists (must be HTTPS; useless for a browser-only app).

### 7.2 Submit request (`VideoGenerationRequest`) **[doc]**

| Field | Type / notes |
| --- | --- |
| `model`* | string |
| `prompt` | string. Optional for models that can generate from image input alone; required otherwise. |
| `duration` | integer >= 1 (seconds). Must be in the model's `supported_durations`. |
| `resolution` | enum `360p 480p 720p 768p 1080p 1K 2K 4K` (the guide omits `360p`) |
| `aspect_ratio` | enum `16:9 9:16 1:1 4:3 3:4 3:2 2:3 21:9 9:21` |
| `size` | `"WIDTHxHEIGHT"`, interchangeable with `resolution` + `aspect_ratio` |
| `frame_images` | array of `{type:"image_url", image_url:{url}, frame_type:"first_frame"\|"last_frame"}` |
| `input_references` | array of `{type:"image_url", image_url:{url}}` \| `{type:"audio_url", audio_url:{url}}` \| `{type:"video_url", video_url:{url}}`. Image refs work everywhere; audio and video refs are honoured only by providers that support them (BytePlus Seedance 2 and newer); others ignore them. |
| `previous_job_id` | string `^gen-vid-\d+-[0-9A-Za-z]{20}$`; id of a **completed** job to edit/extend; runs on the same model and endpoint; "only models that support continuation accept this field". |
| `generate_audio` | boolean; defaults to the endpoint's `generate_audio` flag, false if unset |
| `seed` | integer; determinism not guaranteed |
| `callback_url` | HTTPS URL for a webhook |
| `provider` | `{options:{<slug>:{...}}}` passthrough (keys in the model's `allowed_passthrough_parameters`) |
| `upscale_factor`, `creativity` | for upscaling models only (e.g. `black-forest-labs/flux-video-upscale`) |
| `user`, `session_id`, `trace` | as elsewhere |

If both `frame_images` and `input_references` are sent, `frame_images` wins and the request is image-to-video. Unsupported `duration`/`resolution`/`aspect_ratio` values return 400 that lists the supported values. Verbatim examples:

```json
{
  "model": "alibaba/wan-2.7",
  "prompt": "A character walking through a forest",
  "frame_images": [
    {
      "type": "image_url",
      "image_url": { "url": "https://example.com/first-frame.png" },
      "frame_type": "first_frame"
    }
  ],
  "resolution": "1080p"
}
```

```json
{
  "model": "alibaba/wan-2.7",
  "prompt": "A colossal solar flare beside a planet",
  "input_references": [
    { "type": "image_url", "image_url": { "url": "https://example.com/style-ref.png" } }
  ],
  "resolution": "1080p"
}
```

Spec shape for the other reference types: `{"type":"video_url","video_url":{"url":"..."}}`, `{"type":"audio_url","audio_url":{"url":"..."}}`.

**`data:` URLs, probed (paid round):**

| Input | Result |
| --- | --- |
| `frame_images:[{... frame_type:"first_frame", image_url:{url:"data:image/png;base64,..."}}]` (512x512 PNG, 2,114-char data URL) on `x-ai/grok-imagine-video`, `duration:1, resolution:"480p", aspect_ratio:"1:1"` | **202 accepted**; completed; `usage.cost: 0.052` (= $0.05/s at 480p + $0.002 image input). Output 544x544 H.264 24 fps with an AAC stereo track, 1.04 s, 127,607 bytes (`tests/fixtures/media/video-1s.mp4`). |
| `frame_images` with **both** `first_frame` and `last_frame` data URLs on `bytedance/seedance-2.0-mini`, `duration:4, resolution:"480p", aspect_ratio:"1:1", generate_audio:false` | **202 accepted**; completed after 62 s; `usage.cost: 0.1358`. Output 640x640 H.264, 4.04 s, no audio track, 833,425 bytes. |
| `input_references:[{type:"image_url", image_url:{url:"data:image/png;base64,..."}}]` (no frame_images) on grok | **202 accepted**, completed in about 6 s, `usage.cost: 0.052`. |
| `input_references:[{type:"video_url", video_url:{url:"data:video/mp4;base64,..."}}]` (the 127 KB mp4 above, 170 KB request body) on `bytedance/seedance-2.0-mini` | **400 (free): `Invalid reference URL: input_references[0].video_url.url: Only HTTPS URLs are allowed`**. Video references must be public HTTPS URLs. |

So: **image data URLs work everywhere tried (first frame, last frame, reference); video data URLs are rejected, confirming PLAN's constraint.** "Continue from last frame" needs no hosting; native extend from a user-supplied video needs a public HTTPS link. Whether Seedance accepts an HTTPS `video_url` and extends it was not tested (no hosting available in the probe environment).

**Validation errors (all free 400, fixtures `error-400-video-*.recorded.json`):** unsupported duration `Duration 99s is not supported for this model. Supported durations: 1, 2, ..., 15s` (with `metadata.routing_funnel` and `failed_routing_step:"Validate Video Parameters"`); unsupported resolution `Resolution 4K is not supported for this model. Supported resolutions: 480p, 720p`; no prompt and no image on grok `xAI video generations require a prompt when no image input is provided`. Unknown job id: `404 {"error":{"message":"Job <id> not found","code":404}}` for both `/videos/{id}` and `/content`; `/content?index=5` on a one-video job: `400 Video index 5 out of range (1 videos available)`.

**`previous_job_id` (probed, free rejections):** `x-ai/grok-imagine-video` -> `400 x-ai/grok-imagine-video-20260512 does not support previous_job_id`; `bytedance/seedance-2.0-mini` (using its own completed job) -> `400 bytedance/seedance-2.0-mini-20260811 does not support previous_job_id`. The support is per model and there is no catalog flag, but an unsupported model fails fast and unbilled with that message, so the app can try it and fall back to last-frame continuation. Which model accepts it remains unverified (FLUX.3 Video untested: 5 s minimum at 720p is about $0.85).

### 7.3 Responses **[doc]** **[probed]**

Submit **202** (`VideoGenerationResponse`):

```json
{
  "id": "abc123",
  "polling_url": "https://openrouter.ai/api/v1/videos/abc123",
  "status": "pending"
}
```

Poll **200** when finished (verbatim):

```json
{
  "id": "abc123",
  "generation_id": "gen-1234567890-abcdef",
  "polling_url": "https://openrouter.ai/api/v1/videos/abc123",
  "status": "completed",
  "unsigned_urls": [
    "https://openrouter.ai/api/v1/videos/abc123/content?index=0"
  ],
  "usage": {
    "cost": 0.25,
    "is_byok": false
  }
}
```

Fields: `id*`, `polling_url*`, `status*`, `generation_id`, `error` (string, on failure), `unsigned_urls[]`, `usage{cost: number|null, is_byok}` ("available once the job has completed").

**Status values:** `pending`, `in_progress`, `completed`, `failed`, `cancelled`, `expired`. The guide's table lists only the first four; the spec and webhook payloads add `cancelled` and `expired` (`expired` = "Job exceeded maximum time to live"). Treat `failed|cancelled|expired` as terminal errors. Failed jobs carry `error`.

**Id format conflict:** the spec says `gen-vid-<timestamp>-<20 alphanumerics>`; docs examples show `abc123` and a bare 20-char id (`y34x1YREG4Pkdcj7f02v`). Do not parse ids; store them as opaque strings. `polling_url` may be absolute (guide) or relative (`/api/v1/videos/...` in the spec example): resolve with `new URL(polling_url, "https://openrouter.ai")`. Poll about every 30 s (docs); generation takes 30 s to several minutes. Fixtures: `videos-submit-202.documented.json`, `videos-poll-in-progress.documented.json`, `videos-poll-completed.documented.json`, `videos-poll-failed.documented.json`.

**[probed] real timings and bodies** (fixtures `videos-submit-202.recorded.json`, `videos-poll-pending.recorded.json`, `videos-poll-completed.recorded.json`, `videos-poll-completed-seedance.recorded.json`, `videos-poll-timelines.recorded.json`, `videos-content.recorded.json`):

* Submit returned **202 in 2.4 to 3.6 s** with exactly `{id, polling_url, status:"pending"}`; `id` is `gen-vid-<unix>-<20 alphanumerics>` (so the spec's pattern is correct and the doc examples are not), `polling_url` is **absolute** `https://openrouter.ai/api/v1/videos/<id>`.
* grok-imagine-video, 1 s clip: the first poll about 3 s after submit already said `completed` (`generation_time` 12,350 ms per `/generation`); a second grok job: `pending` at 0.3 s, `completed` at 5.6 s. Seedance 2.0 mini, 4 s 480p: **`pending` at every poll for 61.6 s**, then `completed`.
* **`in_progress` was never observed** in 3 jobs; only `pending` then `completed`. Do not wait for `in_progress`.
* `pending` body: `{id, generation_id (equal to id), polling_url, status}`. `completed` body: `{id, generation_id, polling_url, status:"completed", unsigned_urls:["https://openrouter.ai/api/v1/videos/<id>/content?index=0"], usage:{cost, is_byok:false}}` with `cost` exactly 0.052 / 0.1358.
* Poll requests with `Origin` return `Access-Control-Allow-Origin: *`; preflight 204 on `/videos/{id}` and `/videos/{id}/content`.
* **Cost estimate lesson:** the Seedance price is per token (`tokens = height x width x seconds x 24 / 1024` per the catalog text): 640 x 640 x 4.04 s -> 38,800 tokens x $0.0000035 = $0.1358 exactly. A 480p **1:1** clip is 640x640, not 480x480, so naive estimates were low; grok bills per second ($0.05/s at 480p) and made 544x544.

### 7.4 Download and retention

* `GET /videos/{jobId}/content?index=0` returns `video/mp4` bytes **[doc]**. **[probed]** exactly: `200`, `Content-Type: video/mp4`, **`Transfer-Encoding: chunked` with no `Content-Length`** (a browser cannot show download progress as a percentage), **no redirect** (no `Location`), `Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: X-Generation-Id,...`, body starts `00 00 00 20 66 74 79 70 69 73 6f 6d` (`ftypisom` MP4). **Without `Authorization` it is `401 {"error":{"message":"No cookie auth credentials found","code":401}}`**, so `<video src>` cannot load it: fetch to a `Blob` and use an object URL. A `Range: bytes=0-99` request got the **full body with 200 (not 206)**, so there is no seeking by range. `unsigned_urls[0]` was exactly this same-host content URL in all three jobs, so use it or the constructed URL interchangeably, but prefer the constructed one to stay inside the CSP (`connect-src 'self' https://openrouter.ai`) should a provider ever return another host.
* **Retention:** a completed job was polled and re-downloaded **18 minutes** after completion and the bytes were identical. The real limit is **not documented and not yet bounded beyond 18 minutes**; the docs say only that the provider "must retain the generated video output briefly". Download immediately and treat later re-download as best effort. The `expired` status refers to a job exceeding its time to live.
* Video is **not ZDR-eligible**; ZDR enforcement (account or per request) blocks video routing. **[doc]**

### 7.5 `GET /videos/models` **[probed]**

`{data: VideoModel[]}`; today 30 models. Fixture: `videos-models.json` (all 30, unedited). Each entry:

`id, canonical_slug, hugging_face_id, name, created, description (truncated ~190 chars), supported_resolutions[]|null, supported_aspect_ratios[]|null, supported_sizes[]|null, supported_durations[]|null, supported_frame_images[]|null, generate_audio (bool|null), seed (bool|null), upscale_factor ({min,max}|null), creativity (array|null), pricing_skus ({sku: "price-string"}|null), allowed_passthrough_parameters[]`.

Observations today: 15 models support `first_frame` and `last_frame`, 10 `first_frame` only, 5 have `supported_frame_images: null` (video-edit/upscale/avatar/sora). `generate_audio`: 18 true, 8 false, 4 null. 4 entries have `supported_durations: null` (editors/upscalers: flux-video-edit, flux-video-upscale, heygen/avatar-iv, runway/aleph-2), so filter them out of a text-to-video picker. 11 models have `supported_sizes: null`.

**`pricing_skus` is not uniform.** The SKU names and units vary by model (all values are strings): `duration_seconds[_480p|_720p|_1080p|_with_audio|_without_audio|_4k...]` in USD per second; `video_tokens[_without_audio|_with_video_input|_4k|_1080p]` in USD per **token** (Seedance: tokens = `height*width*duration*24/1024` per its description); `cents_per_second_output[_720p|_1080p]` and `cents_per_second_video_continuation_*` in **cents**; `cents_per_video_output_second_*`, `cents_per_image_input`, `cents_per_megapixel_second_*`, `minimum_cents_per_generation`, `reference_images`, `reference_duration_seconds_*`. An estimate needs per-family logic; the real cost arrives in `usage.cost` on the completed poll. In `/models` the video entries show `pricing: {prompt:"0",completion:"0"}`, which is meaningless for video.

**Native extension / video input signals (all from today's catalog and model pages):**

| Mechanism | Where it appears |
| --- | --- |
| `video` in `architecture.input_modalities` (from `GET /models?output_modalities=video`) | heygen-video-1, flux-video-edit, flux-video-upscale, flux-3-video, runway/aleph-2, hailuo-3, seedance-2.0, seedance-2.0-fast, seedance-2.0-mini, seedance-2.5 |
| `*_with_video_input` pricing SKU | seedance-2.0, -fast, -mini, 2.5 (cheaper when a video is supplied) |
| `video_continuation` pricing SKU and "video continuation workflows" in the description | `black-forest-labs/flux-3-video` |
| Model page text: "video extension", "up to 50 image, video, and audio reference assets" | `bytedance/seedance-2.5` |

No catalog field says which models accept `previous_job_id`; the API rejects unsupported models with a free 400 (section 7.2). Tested unsupported: `x-ai/grok-imagine-video`, `bytedance/seedance-2.0-mini`. Untested: FLUX.3 Video. **[unverified]** for any positive.

---

## 8. Decisions (Jev)

`POST https://openrouter.ai/api/alpha/decisions` **[doc]** [probed: URL exists]. Source: https://openrouter.ai/docs/guides/community/jev-tutorial, https://openrouter.ai/docs/guides/community/jev, https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request

**CORS (the PLAN's open question): browsers can call it.** Preflight `OPTIONS` from `Origin: https://ethanpil.github.io` with `Access-Control-Request-Headers: authorization,content-type,http-referer,x-title` returned `204`, `access-control-allow-origin: *`, `access-control-allow-methods: GET,OPTIONS,PATCH,DELETE,POST,PUT`, and an allow-headers list containing every header requested. A real unauthenticated POST returned 401 with `access-control-allow-origin: *` so the error body is readable. A fake key returned `401 {"error":{"message":"User not found.","code":401}}`. **[probed]** **[probed] authenticated 200:** a real request with `Origin: https://ethanpil.github.io` to `inception/mercury-decide:free` returned `200` with `Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: X-Generation-Id,X-Provider-Name,request-id,cf-ray`, `X-Generation-Id: gen-dec-<unix>-<20 chars>` and `X-Provider-Name: Inception` (`headers-authenticated.recorded.json`). So the success path is browser-readable. The tutorial's "never ship it in browser code" warning is about key exposure, not CORS.

### 8.1 Request **[doc]**

| Field | Type |
| --- | --- |
| `model`* | string: `typesafe/jev-1.13` (resolves to a dated snapshot) or alias `~typesafe/jev-latest` |
| `state`* | string, or object, or array (the content to judge) |
| `questions`* | **object keyed by your own question ids**; each value is a question (below) |
| `provider` | `ProviderPreferences` (same as chat: `data_collection`, `zdr`, `only`, `order`, ...) |
| `session_id`, `trace`, `user` | as elsewhere |

Question types (`type` discriminates):

| `type` | `instructions`* | `criteria` |
| --- | --- | --- |
| **`noul`** (yes/no) | string \| object \| array | `{ "true": <string\|object\|array>, "false": <string\|object\|array> }` (both keys required if `criteria` is present) |
| **`choice`** | string \| object \| array | `{ "<option name>": <description string\|object\|array\|null>, ... }` (required) |
| **`score`** | string \| object \| array | **ordered array** of level descriptions (required). Index 0 is the lowest level. |

Verbatim request (Jev tutorial):

```json
{
  "model": "typesafe/jev-1.13",
  "state": {
    "customer_tier": "enterprise",
    "ticket": "My checkout page shows a blank screen after I click Pay. I have tried two browsers."
  },
  "questions": {
    "is_bug": {
      "type": "noul",
      "instructions": "Is the customer reporting a software defect?",
      "criteria": {
        "true": "The customer describes broken or unexpected product behavior.",
        "false": "The customer is asking a question or requesting a feature."
      }
    },
    "team": {
      "type": "choice",
      "instructions": "Which team should own this ticket?",
      "criteria": {
        "payments": "Checkout, billing, or payment processing issues.",
        "frontend": "Rendering, layout, or browser compatibility issues.",
        "account": "Login, permissions, or profile issues."
      }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is this ticket?",
      "criteria": [
        "Can wait for the next release",
        "Should be fixed this week",
        "Blocking revenue right now"
      ]
    }
  }
}
```

All questions in a request are answered independently in parallel and cannot see each other. Context length is 32,000 tokens (state plus questions). No limit on the number of questions is documented **[unverified]**. Jev returns no reasoning or text.

### 8.2 Response **[doc]**

Verbatim (the tutorial states it is an actual captured response):

```json
{
  "id": "gen-dec-1790015143-AIaTutprXsJ5EwohRSjb",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "is_bug": { "type": "noul", "noul": 0.96 },
    "team": {
      "type": "choice",
      "choice": "payments",
      "confidence": 0.67,
      "probabilities": { "payments": 0.78, "frontend": 0.22, "account": 0 }
    },
    "urgency": {
      "type": "score",
      "score": 1.99,
      "confidence": 0.99,
      "probabilities": { "0": 0, "1": 0, "2": 1 },
      "legend": {
        "0": "Can wait for the next release",
        "1": "Should be fixed this week",
        "2": "Blocking revenue right now"
      }
    }
  },
  "usage": { "input_tokens": 476, "output_tokens": 70, "cost": 0.000019992 }
}
```

| Answer | Fields | Meaning |
| --- | --- | --- |
| `noul` | `type, noul` (number 0-1) | Probability the answer is **yes**. ~0.5 means undecided, not "medium". No `confidence`. |
| `choice` | `type, choice` (string), `confidence?`, `probabilities?` (option -> number) | Selected option, per-option probability, concentration of the distribution. |
| `score` | `type, score` (number), `confidence?`, `probabilities?` (index string -> number), `legend?` (index string -> your criterion) | Probability-weighted 0-based position on your ordered scale (1.99 sits on level 2). |

Top level: `id` ("gen-dec-..."), `model` (dated snapshot), `provider`, `answers`, `usage{input_tokens*, output_tokens*, cost?}`. The spec marks `confidence` and `usage.cost` as optional, so code defensively. Billing is **input tokens only**; output tokens are free; cost is `usage.cost`. Fixtures: `decisions-request.documented.json`, `decisions-response.documented.json` (Jev, from the docs), and **recorded** `decisions-request.recorded.json` / `decisions-response.recorded.json` (the same request sent to `inception/mercury-decide:free`).

**[probed] Mercury Decide response:** `200`, `model: "inception/mercury-decide-20260930"` (dated snapshot of the id you sent), `provider: "Inception"`, `usage: {input_tokens: 253, output_tokens: 6, cost: 0}`; the `noul` answer had only `type` and `noul` (0.99992...), `choice` had `choice`, `probabilities` (3 options) and `confidence`, `score` had `score` (1.9988), `legend`, `probabilities` keyed `"0".."2"` and `confidence`. Probabilities are long unrounded floats and the key order differs from the Jev example, so never depend on order; `id` and `provider` come last in the object. Output tokens were 6 even for 3 questions.

**[probed] Jev (`typesafe/jev-1.13`) with the tutorial request** (fixture `decisions-response-jev.recorded.json`): `200` in 0.3 s, `model: "typesafe/jev-1.13-20260917"`, `provider: "TypeSafe"`, `usage: {input_tokens: 476, output_tokens: 70, cost: 0.000019992}` (the same cost as the docs example, so billing is deterministic per input token). Probabilities were **rounded to 2 decimals** (`noul: 0.96`, choice `{frontend:0.26, account:0, payments:0.74}`, `confidence: 0.6`, score `1.99`), unlike Mercury's long floats; the probabilities differ slightly from the tutorial's published numbers (payments 0.74 vs 0.78), so thresholds must tolerate run-to-run drift. Headers: `X-Generation-Id: gen-dec-<unix>-<20 chars>`, `X-Provider-Name: TypeSafe`, `Access-Control-Allow-Origin: *`. `GET /generation` returned `api_type:"decisions"`, `total_cost: 0.000019992`.

### 8.3 Models **[probed]**

`GET /models?output_modalities=decisions` returns 10 models, all `text->decisions`: `typesafe/jev-1.13`, `~typesafe/jev-latest` (alias_target `typesafe/jev-1.13`), `liquid/d1`, `togethercomputer/tev1-4b-experimental`, `inception/mercury-decide:free`, `upstage/solar-decide`, `respan/span-01`, `respan/span-01-lite`, `respan/span-01-lite:free`, `jaredpalmer/kev-4b`. Jev: context 32,000, input `$0.000000042`/token ($0.042/M), completion `0`. **[probed]** `inception/mercury-decide:free` accepts exactly the Jev request schema (`noul`/`choice`/`score`) and returns the same answer shapes. The other non-Jev models (`liquid/d1`, `togethercomputer/tev1-4b-experimental`, `upstage/solar-decide`, `respan/span-01`, `respan/span-01-lite`, `jaredpalmer/kev-4b`) were not probed (the second free one, `respan/span-01-lite:free`, was skipped to save quota); Span-01 is described as a "behavior scoring model", possibly with a different question type, so treat acceptance as **[unverified]**. Free decision models: `inception/mercury-decide:free`, `respan/span-01-lite:free`.

An alternative surface, `POST /api/v1/systemone`, accepts the TypeSafe SDK shape (`jev-1.13` bare ids). Preflight 204 and unauthenticated 401 **[probed]**. Not needed for the toolbox.

---

## 9. Model catalog

`GET https://openrouter.ai/api/v1/models` **[doc]**, keyless **[probed]**, `Cache-Control: public, max-age=120, stale-while-revalidate=3600, stale-if-error=3600`, gzip (962 KB JSON for `output_modalities=all`, about 107 KB gzipped) **[probed]**. Source: https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties

### 9.1 Query parameters **[doc]**

| Param | Notes |
| --- | --- |
| `output_modalities` | comma-separated, **union**; values `text, image, embeddings, audio, video, rerank, decisions, speech, transcription` or `all`. **Default `text`** (anything whose output includes `text`). Case-insensitive. Any other value returns 400 (ZodError). **[probed]** |
| `input_modalities` | comma-separated from `text, image, audio, file` per the param doc; `video` also works **[probed]** (85 text-output models) |
| `category` | `programming roleplay marketing marketing/seo technology science translation legal finance health trivia academia` |
| `supported_parameters` | comma-separated, e.g. `structured_outputs`, `tools`, `reasoning` |
| `q` | free text on name or slug |
| `sort` | `most-popular newest top-weekly pricing-low-to-high pricing-high-to-low context-high-to-low throughput-high-to-low latency-low-to-high intelligence-high-to-low coding-high-to-low agentic-high-to-low design-arena-elo-high-to-low` |
| `context`, `min_price`, `max_price` (prompt USD/M), `min_output_price`, `max_output_price`, `arch`, `model_authors`, `providers`, `distillable`, `zdr=true`, `region=eu\|us`, `min_age_days`, `max_age_days`, index/rate filters | as in the spec |
| `limit` (1-1000, default 500), `offset` | when **both omitted the full list is returned** (647 entries for `all` came back in one response); otherwise paginate via `links.next`. |

Response envelope: `{data: Model[], total_count, links:{next: string|null}}`. Count helper: `GET /models/count` returns `{"data":{"count":466}}` (text-output only).

### 9.2 Live counts today **[probed]**

| Request | Count |
| --- | --- |
| (default) / `output_modalities=text` | 466 (incl. 11 text+image-output models and 4 text+audio-output models) |
| `output_modalities=all` | 647 |
| `image` | 59 (48 image-only, 9 `image+text`, 2 `text+image`; of which 57 are in `/images/models`) |
| `audio` | 4 (Lyria Pro, Lyria Clip, GPT Audio, GPT Audio Mini) |
| `speech` | 23 |
| `transcription` | 24 |
| `video` | 30 (same set as `/videos/models`) |
| `decisions` | 10 |
| `embeddings` | 37 |
| `rerank` | 9 |
| `input_modalities=image` / `audio` / `file` / `video` (text output) | 295 / 44 / 184 / 85 |
| `supported_parameters=structured_outputs` / `response_format` | 358 / 376 |
| `zdr=true` | 331 |

Locating each kind: TTS = `output_modalities=speech` (voices in `supported_voices`); STT = `transcription`; image = `image` (plus `/images/models` for parameters); video = `video` (plus `/videos/models`); decisions = `decisions`; music = `audio` filtered to id prefix `google/lyria-`; vision = `input_modalities=image`; PDF/file-capable = `input_modalities=file` (any model can take a PDF through the parser, so this only marks native file input); audio-in chat = `input_modalities=audio`.

### 9.3 Model object (`Model`) **[doc]** [probed]

Fixture `models.json` (55 entries, unedited objects; envelope `total_count` is the original 647).

| Field | Notes |
| --- | --- |
| `id`, `canonical_slug`, `name`, `created` (unix s), `description` (truncated ~190 chars with `...`), `hugging_face_id` | `canonical_slug` carries a date suffix for versioned models. |
| `context_length` | integer or null; `0` for many non-text models (all video, many TTS/STT) but a real number for some (Kokoro 4096, Gemini TTS 32768, `mistralai/voxtral-mini-transcribe` 16384). |
| `architecture` | `{modality: "text+image->text", input_modalities[], output_modalities[], tokenizer, instruct_type}`. Input values: `text image file audio video`. |
| `pricing` | object of **strings**; see below. |
| `top_provider` | `{context_length, max_completion_tokens, is_moderated}` |
| `per_request_limits` | **null for all 647 models today.** Schema: `{prompt_tokens, completion_tokens}`. |
| `supported_parameters` | e.g. `temperature, top_p, max_tokens, response_format, structured_outputs, tools, tool_choice, reasoning, include_reasoning, reasoning_effort, seed, stop, ...`; `[]` for decisions models. |
| `default_parameters` | `{temperature, top_p, top_k, frequency_penalty, presence_penalty, repetition_penalty}` values or null. |
| `supported_voices` | `string[] \| null`; TTS voice ids (note `[]` on `openai/whisper-1`). |
| `reasoning` | present on 334 models; see 2.7. |
| `alias_target` | on 19 `~vendor/family-latest` alias entries: `{name, slug}` of the concrete target. |
| `benchmarks`, `knowledge_cutoff`, `expiration_date` (YYYY-MM-DD or null), `links.details` | extras. `expiration_date` is non-null for a few models (e.g. `poolside/laguna-s-2.1:free` 2026-10-31). |

**`pricing` keys observed** in the 647 entries (USD, as strings): `prompt` and `completion` (always present), `input_cache_read`, `input_cache_write`, `input_cache_write_1h`, `web_search`, `image` (per input image), `image_output` (per output image), `image_token`, `audio` (per audio input token), `audio_output`, `input_audio_cache`, `internal_reasoning`, `overrides[]` (conditional pricing: long context, time windows). The spec additionally lists `request` and `discount` (fraction), which no entry used today. **The unit of `prompt`/`completion` is only per-token for text models.** For speech/transcription/video/decisions/image/rerank entries it means something model-specific (section 4.3, 5.3, 7.5), and for routers it can be the sentinel **`"-1"`** (`openrouter/auto`).

**Free models:** a model is free when its `id` ends in **`:free`** (24 of 647: 17 text, 3 embeddings, 2 decisions, 1 speech, 1 rerank; no image, video, STT or music). Do not infer free from `pricing.prompt === "0"`: 107 models match that, including every video model, most image models and the Lyria models. `openrouter/free` is a router that picks free models. `GET /models?max_price=0` is also not equivalent (21 text models today). **[probed]** Free coverage by capability today: text 17 (8 with image input, e.g. `qwen/qwen3.8-27b:free`, `dots-studio/dots-3-note-preview:free`, `google/gemma-4-26b-a4b-it:free`, `google/gemma-4-31b-it:free`, `thinkingmachines/inkling:free`; 5 advertising `structured_outputs`: `apodex/apodex-1.1-mini:free`, `qwen/qwen3.8-27b:free`, `dots-studio/dots-3-note-preview:free`, `liquid/lfm-2.5-2.6b:free`, `nvidia/nemotron-3-super-120b-a12b:free`), **speech 1** (`fish-audio/s2.1-pro-free:free`), **decisions 2** (`inception/mercury-decide:free`, `respan/span-01-lite:free`), embeddings 3, rerank 1, and **none** for image output, audio output (music), video or transcription. Free text entries can carry an `expiration_date` (e.g. `poolside/laguna-s-2.1:free` 2026-10-31), and a free model can be unavailable at any moment (two upstream 429s in 17 requests, section 12.3).

Per-model endpoint detail (keyless): `GET /models/{author}/{slug}/endpoints` returns `{data:{id, name, created, description, architecture, endpoints:[{name, model_id, model_name, context_length, pricing{prompt,completion,discount}, provider_name, tag, quantization, max_completion_tokens, max_prompt_tokens, supported_parameters, supports_tool_choice, status, uptime_last_30m/5m/1d, supports_implicit_caching, native_tools, supports_voice_cloning, supports_multiple_audio_references, supports_image_reference, latency_last_30m, throughput_last_30m}]}}`. The `{slug}` accepts the plain id or the dated `canonical_slug`. `GET /models/user` (auth) returns the list filtered by the key's provider preferences, privacy settings and guardrails.

---

## 10. Key status

`GET https://openrouter.ai/api/v1/key` **[doc]** [probed 200 with a real key]. Auth required (401 without; preflight 204, CORS header present on the 401 **[probed]**). Source: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key, https://openrouter.ai/docs/api_reference/limits

Response `{data:{...}}` (verbatim example; fixture `key.documented.json`):

```json
{
  "data": {
    "allowed_data_regions": ["global", "europe", "us"],
    "byok_usage": 17.38, "byok_usage_daily": 17.38, "byok_usage_monthly": 17.38, "byok_usage_weekly": 17.38,
    "creator_user_id": "user_2dHFtVWx2n56w6HkM0000000000",
    "expires_at": "2027-12-31T23:59:59Z",
    "free_model_daily_requests": { "limit": 50, "remaining": 38, "used": 12 },
    "include_byok_in_limit": false,
    "is_free_tier": false, "is_management_key": false, "is_provisioning_key": false,
    "label": "sk-or-v1-au7...890",
    "limit": 100, "limit_remaining": 74.5, "limit_reset": "monthly",
    "organization_id": null,
    "rate_limit": { "interval": "1h", "note": "This field is deprecated and safe to ignore.", "requests": 1000 },
    "usage": 25.5, "usage_daily": 25.5, "usage_monthly": 25.5, "usage_weekly": 25.5,
    "workspace_id": "0df9e665-d932-5740-b2c7-b52af166bc11"
  }
}
```

* `limit` and `limit_remaining` are **null for an unlimited key**; `limit_reset` is `daily|weekly|monthly|null`. `usage` is all-time USD; `usage_daily` is the current **UTC** day; weekly starts Monday; monthly is the UTC month.
* `free_model_daily_requests{used, limit, remaining}` is the account's free-model counter (resets at UTC midnight). `limit` is 50 or 1,000 by all-time purchased credits. **`is_free_tier` means "has not paid for credits"; it does not select the daily limit.** The per-minute limit (20 RPM) is not reported.
* `rate_limit` is legacy, always `-1`/ignore.
* **Total balance:** `GET /credits` returns `{data:{total_credits, total_usage}}` (account-wide USD, not per key). The docs say it needs a **management key**, but **[probed]** it returned `200` for an ordinary key (`is_management_key:false`, per-key `limit:1`). Fixture `credits.recorded.json` has the shape with the numbers replaced by the docs' example values. Because this contradicts the docs, code should treat 401/403 as "balance unavailable" and show per-key `limit_remaining` instead.
* **[probed] live `GET /key` (fixture `key.recorded.json`, label, creator id and workspace id redacted):** 200, `Cache-Control: private, no-store`, `Access-Control-Allow-Origin: *` with the exposed-headers list. Differences from the docs' example: `rate_limit` was `{requests:-1, interval:"10s", note:"This field is deprecated and safe to ignore."}`; `allowed_data_regions:["global"]`; `limit_reset`, `expires_at`, `organization_id` were `null`; `limit`/`limit_remaining` were numbers (this key had a $1 limit); `is_free_tier:false` together with `free_model_daily_requests.limit:1000`. **`free_model_daily_requests.used` stayed at 2 across ~14 successful free-model requests over ~8 minutes**, so the counter is delayed or does not reflect these calls; do not use it for an exact live "requests left" display and prefer decrementing a local counter from 429s.
* `X-Generation-Id`-based lookups: `GET /generation?id=gen-...` is documented to return `data.total_cost`, `usage`, `tokens_prompt/completion`, `api_type`, `latency`, `provider_name`, ... (fixture `generation.documented.json`). **[probed]** the documented shape is confirmed for chat, image, video, TTS, STT and decisions ids (fixtures `generation-*.recorded.json`; `app_id` and `workspace_id` replaced), but the lookup is eventually consistent: 404 for the first 1 to 8 minutes, then 200 (section 1).

---

## 11. OAuth PKCE (Connect with OpenRouter)

Source: https://openrouter.ai/docs/guides/overview/auth/oauth, https://openrouter.ai/docs/api/api-reference/oauth/exchange-authorization-code-for-api-key (the PLAN's `/docs/oauth` URL redirects to this page **[probed]**)

### 11.1 Step 1: redirect the browser **[doc]**

```text
https://openrouter.ai/auth?callback_url=<YOUR_SITE_URL>&code_challenge=<CODE_CHALLENGE>&code_challenge_method=S256
```

| Param | Notes |
| --- | --- |
| `callback_url` | Where the user returns with `?code=...`. **https URLs, plus `http://localhost` / `127.0.0.1` on any port** (spec text: "Supports https URLs and localhost/127.0.0.1 URLs on any port"). Plain `http` to a public host is not listed as allowed. Localhost apps get a fixed title like `localhost:3000` and no marketplace presence. |
| `code_challenge` | Optional but recommended. |
| `code_challenge_method` | `S256` (recommended) or `plain`. S256 = base64url (no padding) of SHA-256 of `code_verifier`. |
| `key_label` | Prefills the new key's label (max 100 chars via the programmatic variant). |
| `workspace_id` | Preselects a workspace (UUID); user can change it. |
| `required_workspace_id` | Locks the key to one workspace; wins over `workspace_id`. |
| `state` | Returned unchanged as `state` on the callback (CSRF protection). Not returned if the user denies, or in headless mode. |

**No key-limit parameter is documented for this URL** (searched the guide and spec), so "Connect" cannot request a spend limit; the user sets a credit limit on the key afterwards. **[unverified]** whether the page honours an undocumented `limit` query parameter. (`POST /auth/keys/code` takes `limit`, `usage_limit_type: daily|weekly|monthly`, `expires_at`, `key_label`, `workspace_id`, `callback_url`, but it requires authentication.)

Headless mode: omit `callback_url` and send `code_challenge` (required) plus `key_label`; the page displays the code for copy/paste. Codes are single-use and expire after **10 minutes**.

Generating the S256 challenge (verbatim from the docs, using Web Crypto):

```typescript
async function createSHA256CodeChallenge(input: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(hash).toString('base64url');
}
```

(In a browser without `Buffer`, base64url-encode the digest bytes manually: replace `+`->`-`, `/`->`_`, strip `=`.)

### 11.2 Step 2: exchange `POST /api/v1/auth/keys` **[doc]**

No `Authorization` header. CORS preflight 204 and `access-control-allow-origin: *` **[probed]**, so this works from the browser.

```json
{
  "code": "<CODE_FROM_QUERY_PARAM>",
  "code_verifier": "<CODE_VERIFIER>",
  "code_challenge_method": "S256"
}
```

`code_verifier` and `code_challenge_method` are needed only if a challenge was sent. `code_challenge_method` enum `S256 | plain | null`. Response 200:

```json
{
  "key": "sk-or-v1-REDACTED-docs-example",
  "user_id": "user_2yOPcMpKoQhcd4bVgSMlELRaIah"
}
```

Errors **[doc]**: `400 Invalid code_challenge_method`; `403 Invalid code or code_verifier`; `403 Authorization code expired`; `405 Method Not Allowed` (use POST over HTTPS). Observed **[probed]** with a bogus code: `400 {"error":{"message":"Invalid code","code":400}}`; with `{}`: `400 {"success":false,"error":{"name":"ZodError","message":"[...path:[\"code\"]...]"}}`. Fixtures: `auth-keys-response.documented.json`, `auth-keys-invalid-code-400.json`, `error-400-zod-validation.json`.

Deep links (optional): SHA-256 hex of the key gives `https://openrouter.ai/logs?api_key_hash=<hash>` and `https://openrouter.ai/keys/<hash>`.

---

## 12. Limits and errors

Source: https://openrouter.ai/docs/api_reference/limits, https://openrouter.ai/docs/api_reference/errors-and-debugging

### 12.1 Free-model limits **[doc]**

| Credits purchased (all time) | Requests/minute | Requests/day |
| --- | --- | --- |
| < 10 | 20 | 50 |
| >= 10 | 20 | 1000 |

Applies to ids ending `:free`. The higher daily tier starts one credit below the threshold (9 credits). Counters reset at UTC midnight; read the daily counter from `GET /key` -> `free_model_daily_requests`. Paid variants have no platform-level request cap. Cloudflare DDoS protection can block requests that "dramatically exceed reasonable usage". Other limits: credit limits (account balance, per-key limit, **in-flight spending budget**). The in-flight budget can 402 a request even with a positive balance: estimated cost is held while requests run; it only applies to some prepaid accounts and not to free models.

### 12.2 Error body shape **[doc]** [probed]

```json
{ "error": { "code": 401, "message": "No cookie auth credentials found" } }
```

`{error:{code:number, message:string, metadata?:object}}`; the HTTP status equals `error.code`. Spec error schemas also allow top-level `user_id` and `openrouter_metadata`. **[probed]** exact bodies:

* 401 no key: `{"error":{"message":"No cookie auth credentials found","code":401}}` (`error-401.json`)
* 401 bad key: `{"error":{"message":"User not found.","code":401}}` (`error-401-invalid-key.json`)
* 404: `{"error":{"message":"Not Found","code":404}}` (`error-404.json`)
* **[probed, authenticated]** `/chat/completions` errors (all HTTP 400 unless noted; fixtures `error-400-*.recorded.json`). Several include a top-level **`user_id`** (the caller's account id; redacted in fixtures, never log or display it):
  * invalid model: `{"error":{"message":"nonexistent/not-a-model:free is not a valid model ID","code":400},"user_id":"user_..."}`
  * no `messages`/`prompt`: `{"error":{"message":"Input required: specify \"prompt\" or \"messages\"","code":400},"user_id":"user_..."}`; sending `messages` as a string plus a string `max_tokens` produced the same message (the schema error is not specific).
  * body that is not valid JSON: `{"error":{"message":"Input must have at least 1 token.","code":400,"metadata":{"provider_name":null}}}` (misleading text, no `user_id`).
  * mandatory reasoning disabled: see section 2.7. Data policy filter: 404, section 2.9.
* Validation on some routes uses a **different shape**: `{"success":false,"error":{"name":"ZodError","message":"[\n  {...}\n]"}}` with no numeric `code` (`/audio/speech`, `/auth/keys`, `/models?output_modalities=<bad>`). Fixtures `error-400-zod-validation.json`, `error-400-output-modalities.json`. `message` is a stringified JSON array. Handle both shapes.

Status meanings **[doc]**: 400 invalid/missing params (or CORS), 401 invalid key, 402 insufficient credits or key limit, 403 insufficient permission/guardrail/moderation flag, 404, 408, 413, 422, 429, 500, 502 provider failure, 503 no provider matches your routing, 524, 529 provider overloaded.

`error.metadata` **[doc]**: `error_type` (stable key), `provider_code`, `reasons[]`/`flagged_input`/`provider_name`/`model_slug` (moderation), `patterns[]` (guardrail), `file_annotations` (PDF), `limit_source`/`reason`/`remedy_hint` (402).

`error_type` values: `context_length_exceeded, max_tokens_exceeded, token_limit_exceeded, string_too_long, authentication, permission_denied, payment_required, rate_limit_exceeded, provider_overloaded, provider_unavailable, invalid_request, invalid_prompt, not_found, precondition_failed, payload_too_large, unprocessable, content_policy_violation, refusal, invalid_image, image_too_large, image_too_small, unsupported_image_format, image_not_found, image_download_failed, server, timeout, unmapped`. A 500 masks `message` and omits `provider_code`.

### 12.3 429 and Retry-After **[doc]**

```json
{
  "error": {
    "code": 429,
    "message": "Rate limit exceeded",
    "metadata": { "error_type": "rate_limit_exceeded" }
  }
}
```

* A 429 comes from OpenRouter (free-model caps, DDoS) or from the upstream provider (`error.metadata.provider_code` set; OpenRouter retries other providers before returning it).
* **Successful responses carry no `X-RateLimit-*`.** When OpenRouter itself rejects, the 429 carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; `Retry-After` (seconds) may appear on 429, 503, and on a 402 whose `metadata.limit_source` is `openrouter_in_flight_budget` (that 402 is wait-and-retry; other 402s are not).
* A mid-stream rate limit arrives as an SSE error chunk, not an HTTP 429.
* **[probed] two real 429s occurred naturally** (free models behind a shared upstream pool, not the account's own limit; fixtures `error-429-upstream.recorded.json`, `error-429-upstream-2.recorded.json`, headers in `headers-authenticated.recorded.json`):

```json
{
  "error": {
    "message": "Provider returned error",
    "code": 429,
    "metadata": {
      "raw": "liquid/lfm-2.5-2.6b:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations",
      "provider_name": "Liquid",
      "is_byok": false,
      "provider_error_code": "rate_limit_exceeded",
      "limit_source": "upstream_provider_shared_pool",
      "remedy_hint": "Retry shortly, add your own provider key (...), or route to another provider with provider routing: ...",
      "retry_after_seconds": 1,
      "retry_after_seconds_raw": 1,
      "headers": { "Retry-After": "1" }
    }
  },
  "user_id": "user_REDACTED"
}
```

  The first 429 (Google AI Studio, `google/gemma-4-31b-it:free`) had the same `metadata` minus `retry_after_seconds`/`headers` and `provider_error_code:"429"`. Note `message` is the generic "Provider returned error", not "Rate limit exceeded"; branch on `code`, `metadata.limit_source` and `metadata.provider_error_code`. Response headers on both: `Access-Control-Allow-Origin: *`, the usual exposed list, `X-Generation-Id`; **one carried `Retry-After: 1`, the other had no `Retry-After`; neither carried `X-RateLimit-*`**.
* **Browser caveat [probed]:** `Access-Control-Expose-Headers` is `X-Generation-Id, X-Provider-Name, request-id, cf-ray` even on the 429 that sent `Retry-After`, so cross-origin JS **cannot read `Retry-After` or `X-RateLimit-*`**. **Use the body instead:** when present, `error.metadata.retry_after_seconds` (and `metadata.headers["Retry-After"]`) carries the same value and is readable. Fall back to exponential backoff with jitter when neither exists. A 429 from the account's own free-model cap (20/min, 50 or 1000/day) was **not** observed (and was not provoked to protect the quota), so its body and headers are **[unverified]**.
* 402 `limit_source` values: `openrouter_in_flight_budget`, `openrouter_key_limit`, `openrouter_credits`; `reason` `in_flight_budget_exhausted` | `weight_exceeds_budget`. Fixtures: `error-429.documented.json`, `error-402-in-flight-budget.documented.json`, `error-502-provider.documented.json`.

---

## 13. CORS (browser access), measured

All requests from `Origin: https://ethanpil.github.io` on 2026-10-02 **[probed]**. Preflight sent `Access-Control-Request-Method: <m>` and `Access-Control-Request-Headers: authorization,content-type,http-referer,x-title,x-openrouter-title,x-openrouter-categories`. Every preflight returned **204** with identical headers:

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET,OPTIONS,PATCH,DELETE,POST,PUT
Access-Control-Allow-Headers: Authorization,User-Agent,X-Api-Key,X-CSRF-Token,X-Requested-With,Accept,Accept-Version,Content-Length,Content-MD5,Content-Type,Date,X-Api-Version,HTTP-Referer,X-Windowai-Title,X-Openrouter-Title,X-Title,X-Openrouter-Categories,X-Openrouter-App-Visibility,X-Session-Id,X-Stainless-*,Protection-Key,Idempotency-Key,traceparent,tracestate,b3
Access-Control-Expose-Headers: X-Generation-Id,X-Provider-Name,request-id,cf-ray
Vary: Access-Control-Request-Headers
```

No `Access-Control-Allow-Credentials` (do not use `credentials: "include"`), **no `Access-Control-Max-Age`** (browsers re-preflight frequently, adding a round trip to each polled request), and the same result for a random origin and `http://localhost:5173`. `X-OpenRouter-Metadata` is not allowed. Fixture: `cors-headers.json`.

| Endpoint | Preflight | Unauthenticated real request (with `Origin`) | `access-control-allow-origin` on the real response |
| --- | --- | --- | --- |
| `GET /api/v1/models` | 204 | 200 | `*` |
| `GET /api/v1/models/count` | 204 | 200 | `*` |
| `GET /api/v1/models/{a}/{s}/endpoints` | 204 | 200 | `*` |
| `GET /api/v1/videos/models` | 204 | 200 | `*` |
| `GET /api/v1/images/models` | 204 | 200 | `*` |
| `POST /api/v1/chat/completions` | 204 | 401 | `*` |
| `POST /api/v1/images` | 204 | 401 | `*` |
| `POST /api/v1/audio/speech` | 204 | 400 (Zod, body validated before auth); 401 with a valid body | `*` |
| `POST /api/v1/audio/transcriptions` | 204 | 401 | `*` |
| `POST /api/v1/videos` | 204 | 401 | `*` |
| `GET /api/v1/videos/{id}` | 204 | 401 | `*` |
| `GET /api/v1/videos/{id}/content` | 204 | 401 | `*` |
| **`POST /api/alpha/decisions`** | **204** | **401** | **`*`** |
| `POST /api/v1/systemone` | 204 | 401 | `*` |
| `GET /api/v1/key` | 204 | 401 | `*` |
| `GET /api/v1/credits` | 204 | 401 | `*` |
| `GET /api/v1/generation?id=` | 204 | 401 | `*` |
| `GET /api/v1/models/user` | 204 | 401 | `*` |
| `POST /api/v1/auth/keys` | 204 | 400 (`Invalid code` / Zod) | `*` |

Error bodies are therefore readable by browser JS on 401/400. **[probed, authenticated, `Origin: https://ethanpil.github.io`]** the success and error paths all carry `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: X-Generation-Id,X-Provider-Name,request-id,cf-ray` (header name sometimes returned in lower case; treat names case-insensitively): `GET /key` 200, `POST /chat/completions` 200 (JSON and `text/event-stream`), 400, 404 and 429, `POST /audio/speech` 200 (audio bytes), `POST /api/alpha/decisions` 200. So a browser can read streaming bodies, audio bytes and error bodies, and can read `X-Generation-Id` (and `X-Provider-Name` where sent) but **not** `Retry-After` or `X-RateLimit-*`. **[probed, paid round]** the same two headers (`Access-Control-Allow-Origin: *`, the exposed list) were also present on the success paths of `POST /images` (JSON and SSE), `POST /audio/transcriptions` (JSON and multipart), `POST /videos` (202), `GET /videos/{id}` (200), `GET /videos/{id}/content` (200 `video/mp4`, authenticated), the Lyria SSE stream, and `POST /audio/speech` for several providers; the preflights for `/videos/{id}` and `/videos/{id}/content` returned 204 with the usual allow lists (`Range` is not in `Access-Control-Allow-Headers`). `X-Provider-Name` appeared only on some responses (images, decisions) and `X-Generation-Id` on all billable ones (`gen-img-`, `gen-tts-`, `gen-stt-`, `gen-dec-`; video ids are `gen-vid-` and chat ids `gen-`). The `/auth` consent page is a normal top-level navigation, not CORS.

---

## 14. Fixtures index (`tests/fixtures/openrouter/`)

**Recorded (real, from keyless endpoints on 2026-10-02), unedited objects (authenticated recordings follow in the next table):**

| File | Contents |
| --- | --- |
| `models.json` | `GET /models?output_modalities=all` trimmed to 55 models (text incl. free/reasoning/alias/router, vision/audio/video-in, chat image-out, image, Lyria + GPT Audio, TTS, STT, video, all 10 decisions, embeddings, rerank). Envelope `total_count` is the original **647**, not 55. |
| `videos-models.json` | `GET /videos/models`, all 30 models. |
| `images-models.json` | `GET /images/models` trimmed to 15 of 57. |
| `images-model-endpoints.openai-gpt-image-2.json`, `images-model-endpoints.google-gemini-3.1-flash-image.json` | `GET /images/models/{a}/{s}/endpoints`. |
| `model-endpoints.google-lyria-3-pro-preview.json` | `GET /models/google/lyria-3-pro-preview/endpoints`. |
| `models-count.json` | `GET /models/count`. |
| `error-401.json`, `error-401-invalid-key.json`, `error-404.json`, `error-400-zod-validation.json`, `error-400-output-modalities.json`, `auth-keys-invalid-code-400.json` | Real error bodies. |
| `cors-headers.json` | Real preflight and response header sets (cookies and noise removed). |

**Recorded with the throwaway key (`*.recorded.json` / `*.recorded.sse.txt`; free models only; the key, key label, user id, workspace id and account balance are redacted or replaced; generation ids are real but harmless):**

| File | Contents |
| --- | --- |
| `key.recorded.json` | `GET /key`. Label, `creator_user_id`, `workspace_id` replaced with placeholders; counters and limit are real. |
| `credits.recorded.json` | `GET /credits` shape (200 for a non-management key). Numbers replaced by the docs' example values. |
| `chat-completion.recorded.json` | Non-streaming chat, `liquid/lfm-2.5-2.6b:free` (includes `reasoning`, `usage.cost: 0`). |
| `chat-completion-vision.recorded.json` | Base64 PNG data URL, `dots-studio/dots-3-note-preview:free`. |
| `chat-stream.recorded.sse.txt` | Raw SSE bytes (LF framing, usage chunk, `[DONE]`). Load as text; do not re-serialize. |
| `chat-stream-json-schema.recorded.sse.txt` | Raw SSE, `response_format` json_schema, `dots-studio/dots-3-note-preview:free`. |
| `chat-stream-reasoning-length.recorded.sse.txt` | Raw SSE (116 KB): reasoning consumed the budget, `finish_reason:"length"`, empty content. |
| `decisions-request.recorded.json`, `decisions-response.recorded.json` | `POST /api/alpha/decisions` on `inception/mercury-decide:free`. |
| `audio-speech-mp3.recorded.json`, `audio-speech-pcm.recorded.json` | TTS request, response headers (`audio/mpeg`; `audio/pcm;rate=44100;channels=1`), byte count and first bytes. No audio stored. |
| `error-400-invalid-model.recorded.json`, `error-400-missing-messages.recorded.json`, `error-400-invalid-json.recorded.json`, `error-400-wrong-types.recorded.json`, `error-400-reasoning-mandatory.recorded.json` | Real `/chat/completions` 400 bodies (`user_id` redacted). |
| `error-404-data-policy.recorded.json` | `provider.data_collection:"deny"` on a free model. |
| `error-404-generation-not-found.recorded.json` | `GET /generation` for a just-created free-model generation. |
| `error-429-upstream.recorded.json`, `error-429-upstream-2.recorded.json` | Two natural upstream-pool 429s (`user_id` redacted); the second has `retry_after_seconds` and `headers`. |
| `headers-authenticated.recorded.json` | Response headers (status, content-type, cors, `X-Generation-Id`, `Retry-After`, ...) for `/key`, chat JSON and SSE, 400, 429, TTS and decisions. |

**Recorded in the paid round** (real, base64 truncated to the first 100 chars with `...<truncated, N chars>`, `user_id`/`app_id`/`workspace_id` replaced; media kept only when small):

| File | Contents |
| --- | --- |
| `videos-request-first-frame-data-url.recorded.json`, `videos-submit-202.recorded.json`, `videos-poll-pending.recorded.json`, `videos-poll-completed.recorded.json`, `videos-poll-completed-seedance.recorded.json`, `videos-poll-timelines.recorded.json`, `videos-content.recorded.json` | Grok first-frame data-URL job: request, 202, pending and completed polls (cost 0.052), timelines of the 3 jobs, and the content download (headers, 127,607 bytes, 401 without auth, Range ignored, ffprobe). |
| `error-400-video-data-url-input-reference.recorded.json`, `error-400-video-previous-job-id-grok.recorded.json`, `error-400-video-previous-job-id-seedance.recorded.json`, `error-400-video-duration.recorded.json`, `error-400-video-resolution.recorded.json`, `error-400-video-no-prompt.recorded.json`, `error-404-video-job.recorded.json`, `error-400-video-content-index.recorded.json` | Video validation errors (all unbilled). |
| `images-generate.recorded.json`, `images-edit.recorded.json`, `images-stream.recorded.sse.txt` | `/images` generation, edit with a data-URL reference, OpenAI SSE streaming (`: ` comments, partial, completed, `[DONE]`). |
| `error-400-images-n.recorded.json`, `error-400-images-aspect-ratio.recorded.json`, `error-402-chat-image-balance.recorded.json` | Image validation errors and the chat-route $1.00 balance 402. |
| `audio-speech-kokoro-mp3.recorded.json`, `audio-speech-kokoro-pcm.recorded.json`, `audio-speech-gemini-pcm.recorded.json`, `error-400-speech-gemini-mp3.recorded.json`, `error-400-speech-voice-required.recorded.json` | TTS request, headers, byte counts, ffprobe, and per-model format/voice errors. |
| `audio-transcriptions-json.recorded.json`, `audio-transcriptions-verbose.recorded.json`, `audio-transcriptions-multipart-verbose.recorded.json`, `audio-transcriptions-grok.recorded.json`, `audio-transcriptions-diarize-deepgram-options.recorded.json`, `audio-transcriptions-diarize-azure-options.recorded.json`, `error-400-stt-srt.recorded.json`, `error-400-stt-diarize-unsupported.recorded.json` | STT responses and errors (verbose + words, diarization through `provider.options`). |
| `music-lyria-clip.recorded.sse.txt`, `music-lyria-clip-image-wav.recorded.sse.txt`, `music-lyria-pro.recorded.sse.txt`, `music-lyria-clip-request.recorded.json`, `music-lyria-clip-image-wav-request.recorded.json` | Lyria streams: 17/76 keep-alive comments, timed-lyrics chunk, one truncated audio chunk, usage. |
| `decisions-response-jev.recorded.json` | Jev with the tutorial request (the request is `decisions-request.documented.json`). |
| `chat-completion-pdf.recorded.json` | PDF via the `cloudflare-ai` engine on a free model, with `annotations`. |
| `generation-tts|image|video|decisions|chat-music|stt.recorded.json` | `GET /generation` records for each `api_type`. |
| `headers-paid.recorded.json` | Response headers for the paid calls. |

**Small real media** in `tests/fixtures/media/`: `generated-image.jpg` (69,625 B, 1024x1024 JPEG from `/images`), `edited-image.jpg` (105,165 B), `speech.mp3` (13,197 B, Kokoro, 24 kHz mono), `video-1s.mp4` (127,607 B, 544x544 H.264 + AAC, 1.04 s, grok-imagine-video), `invoice.pdf` (604 B, one text page). The Lyria MP3s (745 KB and 4.3 MB) were not kept.

**Hand-built `*.documented.json`** (not recorded; shapes follow the docs or OpenAPI exactly; ids and tokens are invented; the `auth-keys-response` key is a placeholder, not the docs' example key):

| File | Source of shape |
| --- | --- |
| `chat-completion.documented.json`, `chat-completion-image-output.documented.json`, `chat-completion-reasoning-pdf.documented.json`, `chat-completion-error-200.documented.json` | OpenAPI `ChatResult`, usage page, PDF/reasoning/errors guides |
| `chat-stream.documented.json`, `chat-stream-midstream-error.documented.json`, `chat-stream-audio.documented.json` | Streaming page (comment line, usage chunk, `[DONE]`), errors page, audio guide. SSE files are `{ "lines": [...] }`: join with `"\n"` for the raw text. |
| `images-generate.documented.json`, `images-stream.documented.json`, `images-stream-error.documented.json` | Image generation guide |
| `audio-speech-response.documented.json` | TTS guide (headers only; body is binary) |
| `audio-transcriptions.documented.json`, `audio-transcriptions-verbose.documented.json` | STT guide |
| `videos-submit-202.documented.json`, `videos-poll-in-progress.documented.json`, `videos-poll-completed.documented.json`, `videos-poll-failed.documented.json` | Video guide and spec |
| `decisions-request.documented.json`, `decisions-response.documented.json` | Jev tutorial (published example, captured live by the docs authors) |
| `key.documented.json`, `generation.documented.json`, `auth-keys-response.documented.json` | OpenAPI examples |
| `error-429.documented.json`, `error-402-in-flight-budget.documented.json`, `error-502-provider.documented.json` | Limits and errors pages |

---

## 15. Still unverified

Resolved by the probes and removed from this list: PCM sample rate (in `Content-Type`), `Retry-After` readability (no; body `retry_after_seconds`), authenticated CORS on every endpoint class, real SSE framing for chat/image/music, Mercury and Jev schemas, base64 data URLs for video frames and image references (accepted), video data URLs (rejected, HTTPS only), video download behaviour, the Lyria request and stream shape, STT diarization route, `/generation` availability, and PDF engine name.

Still open:

1. **Which video model accepts `previous_job_id`.** Rejected (free 400) by grok-imagine-video and Seedance 2.0 mini; FLUX.3 Video is the candidate (about $0.85 to probe). Also untested: whether Seedance extends a video given as an **HTTPS** `video_url` reference (no public hosting in the probe).
2. **Video retention beyond 18 minutes** (the only data point: still downloadable, identical bytes).
3. **Chat-route image output** (`message.images` shape, `image_config` keys): the request was refused by the $1.00 balance rule, so only `/images` is probed.
4. Whether the **$1.00 minimum balance rule** also applies to other chat-route image/video output paths and to keys whose limit is above $1 but nearly used up.
5. The account's **own free-tier 429** (20 per minute, 50 or 1000 per day): body and headers; and whether `free_model_daily_requests.used` ever advances promptly (it stayed at 2 here).
6. Whether any STT model honours **top-level `diarize`** (four tried, all rejected).
7. **Lyria**: effect of `seed`/`temperature`, multiple reference images, and whether any prompt can change the duration.
8. TTS: per-model **input length limits**; Azure/MAI and ElevenLabs-style models were not probed for `rate` in `Content-Type`.
9. Whether `/auth` honours an undocumented key-limit parameter (11.1).
10. Mistral OCR per-1,000-page price (template variable did not render).
11. Whether `respan/span-01*` and the other non-Mercury, non-Jev decisions models accept the Jev schema; any cap on questions per request.
12. Real `usage.cost` on **text** models with paid pricing (all chat probes used free models; image, TTS, STT, video, music and decisions costs are confirmed).

---

## 16. Spend ledger (paid round, 2026-10-02)

Cap $3.00 (hard stop $2.80); the key itself carried a **$1.00 limit**, which was the effective ceiling. `GET /key` `usage` lags by minutes, so the ledger below uses each response's own `usage.cost`.

| # | Request | Model | Cost (USD) |
| --- | --- | --- | --- |
| 1 | Video, first-frame data URL, 1 s 480p 1:1 | `x-ai/grok-imagine-video` | 0.052 |
| 2 | Video, `previous_job_id` | grok | 0 (400) |
| 3a | Image generation, 1:1 | `black-forest-labs/flux.2-klein-4b` | 0.014 |
| 3b | Image edit with data-URL reference | flux.2-klein-4b | 0.015 |
| 4 | TTS mp3, 44 chars | `hexgrad/kokoro-82m` | 0.000176 |
| 5 | STT x7 successes (whisper turbo x3, grok, MAI, Deepgram) + 5 free 400s | various | 0.000465 |
| 6 | Lyria Clip, lyrics | `google/lyria-3-clip-preview` | 0.04 |
| 7 | Jev tutorial request | `typesafe/jev-1.13` | 0.000019992 |
| 8 | PDF chat, `cloudflare-ai` | `dots-studio/dots-3-note-preview:free` | 0 |
| 9 | Video, video data URL reference | Seedance 2.0 mini | 0 (400) |
| 10 | Video, image data URL in `input_references` | grok | 0.052 |
| 11 | Video, first+last frame data URLs, 4 s | `bytedance/seedance-2.0-mini` | 0.1358 |
| 12 | Video, `previous_job_id` | Seedance 2.0 mini | 0 (400) |
| 13 | TTS pcm x2 (Kokoro 20 chars, Gemini) + 2 free 400s | kokoro, `google/gemini-3.8-flash-tts` | 0.00008 + 0.00057 |
| 14 | Image stream, `quality:"low"` | `openai/gpt-image-1-mini` | 0.003006 |
| 15 | Lyria Clip, image input + `audio.format:"wav"` | lyria-3-clip-preview | 0.04 |
| 16 | Lyria Pro, lyrics | `google/lyria-3-pro-preview` | 0.08 |
| 17 | Chat-route image output | `google/gemini-3.1-flash-lite-image` | 0 (402) |
| 18 | Free validation probes (video, image, content) | various | 0 |
| | **Total** | | **about 0.4331** |
