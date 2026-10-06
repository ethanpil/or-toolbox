# ORtoolbox — Product & Build Plan

Oct 2, 2026 · @Ethan

## Status

This is the plan as delivered in v1.0 (October 2026). All 14 tools and the platform pages are built and shipped. Where the build differs from the plan, [Delivered v1: deviations](#delivered-v1-deviations) says how and why; the text above that section is the original spec, kept as written. One launch task is still open: the Name item under Open questions.

## Vision and principles

ORtoolbox is a "Swiss army knife" of AI tools that runs entirely in the browser: paste one OpenRouter key (or click Connect) and every tool works with good defaults, no server, no account.

**Principles**

1. **Key in, value out.** A first-time user goes from landing page to a finished result in under 60 seconds. Every tool works with zero configuration.
2. **Sensible defaults, deep overrides.** Defaults cascade: tool default → global capability default → per-run override. Advanced options hide behind an "Advanced" disclosure.
3. **Local first, private by design.** All data lives in the user's browser. The only network traffic is to OpenRouter (and the static host). No analytics by default.
4. **One contract, many tools.** Every tool plugs into the same shell through a manifest and a module, and reuses shared parts: drop zone, model picker, job queue, media player, file export.
5. **Cost is always visible.** Estimated cost before a run, actual cost after, running totals on the dashboard.
6. **Fast and delightful.** First paint under 1 s on a mid-range phone, under 150 KB of JS for the shell, purposeful motion that never blocks input.

**Non-goals (v1)**

- No backend, user accounts, or cloud sync (export/import covers device moves).
- No multi-user collaboration or sharing links that carry data.
- No local model inference (WebGPU) — every model call goes to OpenRouter.
- No native mobile apps; the site is an installable PWA instead.
- No pre-made prompt tools: a tool earns its place only if it needs real infrastructure around the model call.

## OpenRouter building blocks

Every modality the toolbox needs is now one key and one base URL away (`https://openrouter.ai/api/v1`), so each tool is a thin UI over one of these endpoints.

| Capability | Endpoint | Used by |
| --- | --- | --- |
| Chat, vision, PDF and audio input, structured JSON | `POST /chat/completions` | Chat, OCR, Data extractor, Table extractor, Bot-to-bot, Model arena |
| Image generation and editing | `POST /images` or chat with image output | Image generation, Image editor, Isolated image |
| Text-to-speech | `POST /audio/speech` | Text-to-speech |
| Speech-to-text | `POST /audio/transcriptions` | Speech-to-text |
| Music (audio output) | chat + `modalities: ["text","audio"]`, streaming only | Music generation (Lyria 3) |
| Video generation | `POST /videos` (async), poll `/videos/{jobId}`, download `/videos/{jobId}/content` | Video studio |
| Video model capabilities | `GET /videos/models` | Video studio form (durations, resolutions, prices) |
| Decisions | `POST /api/alpha/decisions` | Decision (Jev) |
| Model catalog | `GET /models?output_modalities=…` | All model pickers |
| Key status and spend | `GET /key` | Settings, Stats |
| Connect without pasting a key | OAuth PKCE (`/auth` → `POST /auth/keys`) | Onboarding |

**Free models.** Model ids ending in `:free` cost $0 but are limited to 20 requests/minute, and 50 requests/day (1,000/day once the account has bought $10+ of credits). Free-only mode must surface these limits and handle 429s gracefully.

**Decisions modality, resolved:** the `decisions` output modality is Jev from TypeSafe, a decision model that returns typed answers with probabilities and backs the Decision tool.

Sources: [Multimodal overview](https://openrouter.ai/docs/guides/overview/multimodal/overview) · [Video generation](https://openrouter.ai/docs/guides/overview/multimodal/video-generation) · [Audio](https://openrouter.ai/docs/guides/overview/multimodal/audio) · [Audio generation models](https://openrouter.ai/collections/audio-models) · [Jev tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial) · [Models API](https://openrouter.ai/docs/api/api-reference/models/get-models) · [OAuth PKCE](https://openrouter.ai/docs/oauth) · [Limits](https://openrouter.ai/docs/limits) · [Every modality, one API](https://openrouter.ai/blog/insights/every-modality-one-api/)

## Tool catalog

The toolbox ships 14 tools, and every one exists because it needs machinery a user would otherwise have to build: file handling, async jobs, media processing in the browser, or a purpose-built editor. Pre-made prompts are out of scope.

All 14 tools ship in v1, each as its own page; there is no generic workflow system. The build order and test gates are in the Delivery plan.

| Tool | The infrastructure the GUI provides | In → out |
| --- | --- | --- |
| Chat | Multi-model chat, file and image attachments, branching, mid-chat model switch | Text, files → conversation, Markdown export |
| OCR | PDF rendering (pdf.js), page selection and batching, handwriting and math modes | Images, PDFs → Markdown, TXT, DOCX |
| Data extractor | Visual schema builder, batch over many files, review grid with corrections; Invoice/receipt is the default preset | Images, PDFs → JSON, CSV, XLSX |
| Speech-to-text | Mic recording, upload, long-audio chunking, timestamps, speaker labels where supported | Audio, video → TXT, SRT, VTT, JSON |
| Text-to-speech | Voice picker with previews, long-text chunking, stitching into one file | Text, TXT/MD file → MP3, WAV |
| Image generation | Aspect ratio and size controls, variations, reference images, gallery | Prompt, images → PNG, JPG |
| Decision | Visual builder for Jev questions (yes/no, choice, score), probability results, thresholds | State → typed answers with probabilities |
| Isolated image | Background isolation plus deterministic browser post-processing to a square on pure #FFFFFF, with QA check | Product photos → square JPG/PNG, ZIP |
| Bot-to-bot chat | Two models in a moderated loop with turn, time, cost and stop-phrase limits | Two models + opener → transcript |
| Video studio | Async job queue, first/last frame, references, upload a video to continue, auto-extend sequences, clip timeline and joining | Prompt, images, uploaded or generated clips → MP4 |
| Music generation | Song form with lyrics editor, instrumental toggle, duration, streamed audio assembly | Prompt, lyrics, image → MP3, WAV |
| Image editor | Canvas with painted masks for inpaint/outpaint, history of versions | Image + mask → PNG |
| Table extractor | Detects tables and charts in pages, editable grid before export | Images, PDFs → CSV, XLSX |
| Model arena | Same input to 2–4 models in parallel, blind voting, cost and latency side by side | Prompt, files → comparison |

### Video studio (detail)

- **Modes:** text-to-video; first frame; first + last frame (`frame_images` with `first_frame` / `last_frame`); references (`input_references` as style or content guides). The UI never sends frames and references together, because frames take precedence.
- **Bring your own video:** upload an MP4/MOV/WebM, or pick any clip from the session, as the starting point for Continue, Extend or Auto-extend.
- **Continue from last frame (works with every image-to-video model):** the browser seeks to the clip's final frame, captures it on a canvas and starts a new job with it as `first_frame` plus a continuation prompt. The new clip joins the timeline after the source clip. This is the default way to lengthen any video, uploaded or generated.
- **Native extend (supported models only, e.g. Seedance 2.5):** the source video is sent as a `video_url` entry in `input_references`, so the model continues the actual footage, not just one frame. Constraint: OpenRouter appears to reject local `data:` URLs for video, so the source must be a public, directly downloadable HTTPS link. With no server, the user pastes such a link (their own hosting or cloud storage share); an uploaded file falls back to Continue automatically. Generated clips can't be used directly either, because their download links need the user's key.
- **Auto-extend (sequence runner):** the user builds an ordered list of steps; each step has a prompt and optional images (reference images, or a last-frame target). Two run modes:
  1. **Chained:** each step starts from the previous clip's last frame (or native extend when available), so the result plays as one continuous shot.
  2. **Independent:** each step is its own job from its own prompt and images; clips are joined in order at the end. Options: repeat the list N times, one shared style prompt appended to every step, a total cost estimate before starting, a per-sequence spend cap, stop or skip on a failed step, pause and resume, and re-run any single step without redoing the rest. Chained steps run one at a time; independent steps can run up to 3 in parallel.
- **Frame grabber:** scrub any clip and save a frame as PNG, ready to use as a first/last frame or reference.
- **Timeline and joining:** reorder clips, trim ends, drop the duplicated first frame of chained clips, and export one MP4 in the browser. Joining and trimming use multi-threaded ffmpeg.wasm, made possible on GitHub Pages by cross-origin isolation (see Architecture); the single-threaded core is the fallback.
- **Job queue:** job ids and step state are saved so polling resumes after a reload; a browser notification fires when a job or sequence finishes.
- **Model-aware form:** durations, resolutions, aspect ratios and sizes come from `/videos/models`; cost estimate from the model's per-second price before submitting.
- **To verify:** whether `frame_images` and image `input_references` accept base64 data URLs; whether video `data:` URLs are truly rejected; which models support native extension; how long OpenRouter keeps finished videos available for download.

### Decision (detail)

- **API:** `POST /api/alpha/decisions` with model `typesafe/jev-1.13` (or the `~typesafe/jev-latest` alias). Jev returns typed answers with probabilities, not text, and bills input tokens only.
- **State panel:** key-value fields or a pasted text block describing the situation being judged.
- **Question builder:** add any number of questions, each with instructions and one of three types: Yes/No (criteria for true and false), Choice (named options, each with a description), Score (an ordered scale; drag to reorder levels).
- **Results:** a probability meter for Yes/No, bars per option for Choice, a marker on the scale for Score, plus confidence and cost (`usage.cost`).
- **Thresholds:** per question, the user sets a confidence threshold; results show "Clear" or "Needs review".
- **Saved deciders:** a question set can be saved, renamed and reused; starter templates for ticket triage, approve/escalate and content review.
- **To verify:** the alpha endpoint accepts browser (CORS) requests.

### Isolated image (detail)

1. **Isolate:** the photo goes to an image-editing model with a fixed instruction: keep the product unchanged, remove everything else, pure white background, sharp and evenly lit.
2. **Square:** the browser finds the product's bounding box and centers it on a square canvas with a margin (default 8%) at the chosen size (default 2000 × 2000 px).
3. **Pure white:** a flood fill from the edges sets near-white background pixels (threshold adjustable, default 245) to exactly #FFFFFF, so white parts inside the product are untouched.
4. **Sharpen:** optional unsharp mask at a light default.
5. **QA:** checks that every border pixel is #FFFFFF and that the product doesn't touch the edge; shows pass or fail per image.

The review screen has a before/after slider, per-image margin and threshold controls, and retry with another model. Export is JPG (quality 92) or PNG, singly or as a ZIP, with a filename pattern. A side-by-side view helps catch generative changes to logos or text on the product.

### Bot-to-bot chat (detail)

- **Setup:** Bot A and Bot B each get a model, a name and an optional persona; the user writes the opening prompt and picks who speaks first.
- **Mechanics:** each bot sees its own turns as assistant messages and the other bot's as user messages; replies stream; old turns are trimmed when the context limit nears.
- **Stop conditions (first one hit wins):** turn limit (default 20), time limit (default 5 min), cost cap (default $0.25), a stop phrase either bot says (default `[END]`), or the Stop button.
- **Moderation:** pause, step one turn at a time, inject a moderator message, edit a turn and resume from there.
- **Display:** alternating bubbles with avatars and per-turn tokens, cost and latency; running totals in the header.
- **Export:** Markdown or JSON transcript; replay in the history view.

### Music generation (detail)

- **Models:** Google Lyria 3 Pro (full songs with verses, choruses and vocals) and Lyria 3 Clip (short clips), reached through chat completions with audio output and streaming.
- **Form:** genre, mood, tempo, instruments, vocals or instrumental, a lyrics editor with section tags (\[Verse\], \[Chorus\], \[Bridge\]), target duration, one optional reference image, MP3 or WAV.
- **Output:** streamed base64 chunks are assembled into a file with a live progress bar, then a waveform player, variations side by side, and download.
- **To verify:** the exact request fields for lyrics, instrumental and duration on OpenRouter, and current per-song pricing.

## Platform features

The shell around the tools is what makes this a product rather than a folder of demos: one settings page, one model catalog, one history, one dashboard.

**Settings (central page, exportable)**

- **Keys:** a default key plus any number of named keys ("Work", "Free sandbox"), each with an optional colour and a live balance from `GET /key`. A "Connect with OpenRouter" button (PKCE) creates a key without copy-paste.
- **Per-tool binding:** each tool can pin a key and a model; otherwise it uses the defaults.
- **Default models per capability:** text, vision, image out, speech, transcription, video, music, decisions. Shipped defaults are cheap and fast; the user can change them.
- **Free-only mode:** one global switch, off by default. When on, it hides and blocks every model that isn't free, shows remaining daily free requests, and swaps defaults to the best free model per capability, with a clear note where none exists (e.g. video, music).
- **Budgets:** the user picks one mode: Disabled, Warn (confirm before a run that would exceed the limit), or Hard stop (block the run). Limits can be set per key and per month, plus a per-run threshold (default $0.10) that triggers a confirmation in Warn and Hard-stop modes.
- **Appearance:** light/dark/system theme, accent colour, density, reduced motion.
- **Data:** history retention (default 90 days), storage used, delete prompts and history per tool or for the whole app, reset everything.
- **Backup/restore:** export everything (or settings only) to a `.ortoolbox.json` file; keys excluded by default, or included and encrypted with a passphrase. Import merges or replaces, with a preview of what will change.

**Model catalog**

- Cached copy of `/models` (refreshed daily or on demand) with search and filters: modality in/out, free, price, context length, provider.
- Favorites and a "recently used" list feed every model picker.
- Each model card shows price per 1M tokens, context, modalities and the user's own stats for that model (runs, average latency, spend).

**History**

- History keeps text only: tool, prompts and settings, text outputs (transcripts, OCR text, extracted JSON, decisions, bot transcripts), model, key alias, tokens, cost, latency, status. Images, audio, video and uploaded files are never stored.
- Binary results live in memory for the session. If the page holds results that haven't been downloaded, leaving or reloading shows a warning listing what will be lost (e.g. "3 images and 1 video not downloaded"), with a "Download all" shortcut.
- For video jobs, history also keeps the job id, so a finished video can be downloaded again while OpenRouter still holds it.
- Searchable timeline across all tools; reopen a run's settings in its tool, re-run with another model, star, export as JSON.

**Prompts in each tool**

- Every tool has a **Prompts** button next to its main input that opens a panel with two tabs: **Recent** (filled automatically from that tool's runs) and **Saved** (prompts the user chose to keep, with an optional name).
- A saved prompt stores the text plus that tool's settings at the time (e.g. voice and format for text-to-speech, aspect ratio for images, the whole step list for a video sequence), so "Use" restores the form exactly.
- Actions per prompt: Use, Save (from Recent), Rename, Copy, Delete. Per tool: Clear recent, Clear saved, Clear all for this tool. Every delete asks for confirmation and offers Undo in a toast that stays until the user dismisses it.
- Saved prompts never expire; Recent follows the history retention setting. A **Record recent prompts** switch (on by default) lets privacy-minded users turn auto-saving off.
- **Settings → Data** lists prompt counts per tool with a delete button on each row, plus **Delete all prompts and history** for the whole app (keys and settings untouched) and a separate **Reset everything** that also removes keys and settings. Both need a typed confirmation.
- Saved prompts are included in backup/restore and sync live across open tabs.

**Stats dashboard**

- Spend and requests over time, by tool, model and key.
- Tokens in/out, average latency and error rate per model, free vs paid share.
- Key balances and budget burn-down; free-tier requests left today.
- All charts computed locally from history; nothing leaves the browser.

**Everywhere**

- Command palette (Ctrl/Cmd+K) to jump to any tool, run, model or setting.
- Drag-and-drop and paste (images, files, audio) onto any tool; "Send to…" moves an output into another tool.
- Streaming output, stop button, retry with fallback model, copy/download in sensible formats.
- Installable PWA with an offline shell (tools need network, history and settings do not).
- First-run onboarding: paste/connect key → pick 3 favorite tools → try a sample.

## Architecture (proposed)

A multi-page static site where every page loads the same small core library, so settings, keys, history and stats are shared by all tools on the same origin without a server.

&#91;embedded content: or-toolbox architecture · pages, core, storage, OpenRouter\]

Pages never talk to OpenRouter or storage directly; they go through the core, which is what keeps keys, defaults, cost tracking and history consistent across every tool.

**Pages.** One HTML page per tool (`/tools/ocr/`, `/tools/video/`…) plus Home, Settings, Models, History and Stats. Separate pages keep each tool's code isolated and fast to load; cross-document **View Transitions** make navigation feel like a single app.

**Storage.** Cookies are a poor fit (4 KB limit, sent to the host on every request), so the plan uses them for nothing.

| Store | Holds | Why |
| --- | --- | --- |
| localStorage | Settings, key aliases, defaults, favorites, UI state (< 100 KB) | Synchronous read at page start, shared by every page on the origin |
| IndexedDB | Text-only run history, saved and recent prompts per tool, video job queue and sequence state, cached model list, stats rollups | Larger capacity than localStorage, async, survives reloads |
| Memory only | Images, audio, video and uploaded files during a session | Never written to disk; leave-page warning protects undownloaded results |
| sessionStorage | Unlocked key material when the passphrase lock is on | Removed by auto-lock or Lock now; browsers may restore it with a closed tab (see Delivered v1: deviations) |

**Cross-page and cross-tab sync.** A `BroadcastChannel('ortoolbox')` announces changes ("settings changed", "run finished") so open tabs update live; the `storage` event is the fallback. Schema has a `version` and migrations run at page start.

**Cross-origin isolation for ffmpeg.wasm.** Multi-threaded ffmpeg.wasm needs SharedArrayBuffer, which browsers only allow on cross-origin isolated pages (COOP `same-origin` plus a COEP header). GitHub Pages can't set headers, so the site's own service worker adds them to every response it serves, the technique from [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) described in [this article](https://dannadori.medium.com/how-to-deploy-ffmpeg-wasm-application-to-github-pages-76d1ca143b17).

- **One worker:** the header injection lives in the site's single service worker (which also serves the offline shell), so no second worker competes for the same scope.
- **First visit:** the page registers the worker and reloads once; later visits are isolated from the first byte. Code checks `crossOriginIsolated` before choosing which ffmpeg core to load.
- **COEP mode:** `credentialless` where supported, `require-corp` otherwise. OpenRouter calls are CORS requests and keep working; every script, font and wasm file is self-hosted, so nothing is blocked. Sign-in with OpenRouter uses a full-page redirect, which COOP doesn't affect.
- **Fallback:** if the worker can't run (some private-browsing modes), the single-threaded ffmpeg core loads instead: slower, same output.
- **Loading:** the ffmpeg core files (about 30 MB) are self-hosted and fetched only when the user joins or trims clips, then cached by the worker.
- **CSP:** the meta policy allows `'wasm-unsafe-eval'` for scripts and `blob:` for workers.
- **Proved first:** Stage 0 of the Delivery plan runs ffmpeg multi-threaded on the real GitHub Pages URL before anything depends on it.

**Core library (`/core`)** — used by every page:

- `api` — one OpenRouter client: auth header, app attribution headers, streaming, retries with backoff on 429/5xx, abort, usage and cost capture on every response.
- `jobs` — persistent queue for long-running work (video jobs, batches): saved in IndexedDB, resumes polling after reload, notifies on completion.
- `media` — browser-side processing: canvas helpers (crop, pad, flood fill, sharpen), frame capture from video, audio chunk assembly, ffmpeg.wasm loaded on demand (multi-threaded when the page is cross-origin isolated, single-threaded otherwise).
- `settings` — typed get/set with defaults cascade (run → tool → capability → global).
- `models` — catalog cache, filters, free-only enforcement.
- `history` — IndexedDB wrapper for text-only runs; emits stats events; tracks undownloaded in-memory results for the leave-page warning.
- `ui` — the shell (header, palette, toasts), the design-system components, and shared input and output parts.

**Tool contract.** Each tool is a folder with a `manifest.json` and a `main.ts`; a registry lists them for Home and the palette. The manifest declares what the shell needs to know before the code loads:

```json
{
  "id": "isolated-image",
  "name": "Isolated image",
  "category": "images",
  "icon": "square-dashed",
  "capabilities": ["image-edit"],
  "accepts": ["image/png", "image/jpeg", "image/webp"],
  "produces": ["image/jpeg", "image/png", "application/zip"],
  "usesJobs": false,
  "lazyLibs": ["jszip"],
  "defaults": { "size": 2000, "margin": 0.08, "whiteThreshold": 245, "format": "jpg" },
  "entry": "./main.ts"
}
```

`main.ts` receives one context object (api, jobs, media, settings, history, ui) and mounts into the page. Because drop zones, model pickers, players, grids and exporters are shared components, a new tool is mostly its own pipeline logic plus layout.

**Tech stack (decided).** Vite multi-page build to plain static files, TypeScript, Bootstrap 5.3 and Bootstrap Icons with plain TypeScript modules (no UI framework), Bootstrap color modes for light and dark, no runtime CDN scripts. Hosting on GitHub Pages, deployed by a GitHub Actions workflow; Vite's base path matches the repo path, and the OAuth callback URL points at the deployed site. Tests: Vitest for core, Playwright against a mocked OpenRouter.

## Design and UX direction (proposed)

Every tool page uses the same three-zone layout, so a user who learns one tool knows them all: **input on the left, output on the right, settings in a drawer**. Desktop first; on tablets and phones the same layout stacks responsively, with no separate mobile design.

**Key screens**

1. **Home** — search bar first, then Favorites, Recent runs and a category grid of tool cards (icon, name, one-line purpose, "free" badge when the tool's default model is free).
2. **Tool page** — header with tool name, model chip (click to switch), key chip, cost estimate; big drop zone; primary Run button; streaming output with actions bar.
3. **Settings** — tabs: Keys, Models, Defaults, Appearance, Data and backup.
4. **Models** — filterable catalog with comparison tray.
5. **History** — timeline with filters and a run detail drawer.
6. **Stats** — dashboard of cards and charts with date range picker.

**Visual language (decided): plain Bootstrap.** Stock Bootstrap 5.3 components and Bootstrap Icons with minimal customisation, so the interface is simple, familiar and organised. Light and dark use Bootstrap's built-in color modes (`data-bs-theme`), with a navbar toggle for Light / Dark / System that every page shares. Customisation is limited to a handful of Sass variables: one primary colour, the system font stack, and slightly larger border radius. Layout uses the standard grid, cards, list groups, nav tabs, accordions for advanced options, modals for confirmations, offcanvas for the settings drawer, toasts for status, and progress bars for jobs.

**Motion (delightful, never in the way).**

- Cross-page View Transitions: a short cross-fade between pages so the site feels like one app.
- Streaming text appears as it arrives; Bootstrap placeholders (skeletons) while the first token loads.
- Job progress uses animated Bootstrap progress bars; finished results fade in.
- Drop zones highlight on drag-over.
- All motion 150–250 ms, transform and opacity only, and switched off under `prefers-reduced-motion`.

**Performance budgets.** Shell JS ≤ 150 KB gzipped, each tool ≤ 80 KB more; Largest Contentful Paint < 1.2 s on a mid-range phone; heavy libraries (pdf.js, docx parser, chart lib) load only when a tool needs them.

**Accessibility.** WCAG 2.2 AA: keyboard reachable everything, visible focus, labelled controls, live regions announcing streaming status, contrast checked in both themes.

**Design deliverables:** the Sass variable overrides, a page template showing the three-zone tool layout, wireframes for the five platform pages and the 14 tools in light and dark, narrow-window layouts, and empty, error and rate-limit states. Because the components are stock Bootstrap, no custom component library is needed.

## Security and privacy

The main risk is the API key: anything stored in the browser is readable by any script running on the same origin, so the plan keeps third-party code off the origin entirely and makes encryption at rest available.

- **No third-party scripts at runtime.** All libraries are bundled and self-hosted; no analytics, fonts or CDNs loaded from other domains.
- **Strict Content Security Policy:** `script-src 'self'`, `connect-src 'self' https://openrouter.ai`, no inline scripts. Set with a meta tag in every page, because GitHub Pages can't send custom headers.
- **Optional passphrase lock:** keys encrypted with AES-GCM using a key derived by PBKDF2 (WebCrypto). Unlocked once per tab session; auto-lock after inactivity.
- **Spend-limited keys recommended:** onboarding suggests a key with a credit limit; PKCE connect can request a limit when creating the key.
- **Masked display:** keys show as `sk-or-…a1b2` with reveal-on-hold; never logged, never in URLs, excluded from exports unless the user opts in (then encrypted).
- **Rendering safety:** model output rendered as Markdown is sanitised (DOMPurify); generated HTML (screenshot-to-code) previews only in a sandboxed iframe.
- **Data stays local:** history and files never leave the browser except as the request body to OpenRouter for that run. A "Privacy" page explains this plainly and links to OpenRouter's data policies; a per-key setting can prefer providers that don't retain data (verify the routing option name before build).

## Delivery plan

All 14 tools ship together as v1, built in nine stages; each stage ends at a test gate, and the next stage starts only when the gate passes.

**Every gate runs the same six checks:**

1. Unit tests (Vitest) for all new core code.
2. Playwright end-to-end tests against a mocked OpenRouter that replays recorded responses, including errors, 429s and slow video jobs.
3. Live smoke test on the GitHub Pages deployment with a spend-limited key, using free models where they exist.
4. Manual pass in Chrome, Firefox and Safari, in light and dark mode, at desktop and narrow widths.
5. `/code-review max` on the stage's changes; every finding is fixed or recorded with a reason.
6. Merge to main, deploy, tag the stage.

| Stage | Builds | Gate-specific tests |
| --- | --- | --- |
| 0. Foundations | Repo, Vite multi-page build, strict TypeScript, Bootstrap 5.3, lint and format, GitHub Actions deploy to Pages, CSP meta, service worker with cross-origin isolation, mock OpenRouter for tests; API spikes for every "To verify" item | Multi-threaded ffmpeg.wasm runs on the live Pages URL; `crossOriginIsolated` is true after the first reload; single-threaded fallback works with the worker disabled; spike results written into this doc |
| 1. Core library | API client (streaming, retries, abort, cost capture), settings and defaults cascade, keys, Connect with OpenRouter, model cache and free-only mode, budgets (three modes), text history, prompt store (saved and recent per tool), job queue, stats rollups, leave-page guard, backup/restore with encryption | Sign-in round trip on Pages; each budget mode warns or blocks correctly; backup, wipe, restore gives identical settings; keys never appear in an export unless opted in |
| 2. Shell and platform pages | Layout, navbar, theme toggle, command palette, shared parts (prompts panel, drop zone, model picker, key chip, cost estimate, output panel, media players, exporters), Home, Settings, Models, History, Stats, onboarding, privacy page | Keyboard-only walk-through; axe accessibility scan clean; theme persists across pages and open tabs; saving, reusing, deleting and clearing prompts works per tool and app-wide, with undo |
| 3. Text and document tools | Chat, OCR, Data extractor, Table extractor | 20-page PDF through OCR; batch of 10 receipts to an XLSX that opens in Excel and Google Sheets |
| 4. Audio tools | Speech-to-text, Text-to-speech, Music generation | 60-minute recording chunked with continuous timestamps; 10,000-word text stitched with no gaps; music streams into a playable file |
| 5. Image tools | Image generation, Image editor, Isolated image | Isolated image passes QA (every border pixel #FFFFFF) on a 20-photo test set; mask edit round trip |
| 6. Video studio | All modes, job queue, Continue, native extend, auto-extend sequences, frame grabber, timeline, ffmpeg joining | 5-step chained sequence survives a reload mid-run; joined MP4 plays in all three browsers and VLC; spend cap stops a sequence |
| 7. Decision, Bot-to-bot, Model arena | Jev question builder and results, bot loop with moderation, parallel arena | Every bot stop condition triggers; arena runs 4 models at once; Decision handles each question type |
| 8. Release | Performance budgets, cross-browser pass, security review (CSP, key handling, output sanitising), user docs and README | Lighthouse 90+ on Home and two tools; `/code-review max` on the whole repository; v1.0 tag |

## Delivered v1: deviations

What differs from the plan above, and why. Everything else in the plan was built as written.

**Process**

- **Gates ran locally, per stage.** Each stage ended at a local gate (unit tests, Playwright against the mocked OpenRouter, a review of the stage's changes) and was tagged `stage-0` to `stage-7` on its own branch. The live smoke test on Pages and the OAuth round trip against the real OpenRouter are done once, after the site is published, not at each stage.
- **Browsers.** The automated suite runs in Chromium, Firefox and WebKit; WebKit stands in for Safari. The joined MP4 is decoded and played by the automated gate in Chromium only; playback in Firefox, Safari and VLC is a manual check.
- **Lighthouse 90+.** Met on desktop and on mobile Home. Not met on mobile Chat, whose performance score stays under 90 on Lighthouse's throttled mobile profile.
- **Whole-repository review.** Instead of one `/code-review max`, Stage 8 ran independent finders over the whole repository, each finding was verified separately, and the fixes shipped in rounds (see the changelog).
- **XLSX.** The Data extractor's XLSX is checked by unzipping and parsing it in the e2e gate, and by a spreadsheet reader (openpyxl) in CI. It was not opened in Excel or Google Sheets.

**Security and delivery**

- **COEP is always `require-corp`**, not `credentialless` where supported. Nothing is hot-linked, so `credentialless` would buy nothing and needs per-browser negotiation.
- **No `blob:` workers.** The CSP allows `worker-src 'self'` only: ffmpeg's ESM cores are self-hosted and the wasm is handed over as a `blob:` URL, but no worker or script is a `blob:`. There are no frames at all (`frame-src 'none'`), so the plan's sandboxed-iframe preview has no use.
- **The CSP is also a response header.** The meta tag stays, and the service worker adds the same policy as a header on documents and workers, with `frame-ancestors 'none'` (a meta tag cannot set it). A small script in `theme-init.js` hides a framed page on the first visit, before the worker controls it.
- **Isolation reload on two pages only.** Diagnostics and Video studio reload once on a first visit to become isolated; every other page only registers the worker. The reload never happens once the user has started using the page. The OAuth callback must never reload.
- **The service worker verifies what it caches.** Every cached file is checked against a SHA-256 recorded at build time, because every project site on `github.io` shares one CacheStorage.
- **Unlock state outlives the tab.** The unlocked key sits in `sessionStorage`, which browsers may restore with a closed tab, so it is not "cleared when the tab closes". Auto-lock (24 hours at most) and Lock now remove it, and the Privacy page says so.
- **Connect does not request a credit limit.** The PKCE exchange creates a key without one. The Connect help, the key field and the Privacy page recommend setting a limit on OpenRouter afterwards.
- **Sanitized output is an allowlist.** Markdown from models loses classes, `data-*`, ARIA attributes and the other attributes that could draw fake dialogs or drive page controls.
- **Third-party notices** ship as `licenses.txt` on the site and `THIRD-PARTY-NOTICES.txt` in the repository, with the source of the GPL ffmpeg.wasm cores. The project's own license is not chosen yet.

**Behavior**

- **Leaving the page.** In-app links get the plan's dialog with Download all. Reloads, closing the tab and typed addresses get the browser's own prompt, which cannot carry custom text. Leaving during a run now asks too.
- **Video notifications are opt-in** (a switch in the video drawer; permission is asked only when the user turns it on, and a notification shows only while the page is hidden), not on by default.
- **No auto-join.** A finished sequence does not join its clips by itself; the user presses Join, which runs ffmpeg with its own Stop. Joins are capped at 1.5 GiB, the most the browser can allocate.
- **Native extend and Previous job.** Native extend sends a public HTTPS link only to models priced with video input; every other model falls back to Continue. No model is confirmed to take `previous_job_id`, so it is not sent.
- **Settings is one page of deep-linkable sections** (keys, default models, tools, budgets, appearance, security, data, backup), not tabs.
- **Storage that cannot save.** A browser that blocks `localStorage` or IndexedDB gets a notice and a plain error, instead of settings that silently revert.
- **Retries never pay twice.** A request that may have been billed (network loss after sending, a 5xx or 408 on a paid call) is never re-sent by itself, and its Retry asks first. The plan's "retry with fallback model" is the user's choice, not automatic.

## Open questions

Your answers turn this draft into the v1 build plan; the first four matter most because they change the architecture.

- [x] **Audience:** public site, with onboarding, Connect with OpenRouter and a privacy page.
- [x] **Build step:** Vite + TypeScript, output is plain static files.
- [x] **Storage:** localStorage for settings, IndexedDB for text history and job state, no cookies, no stored binaries.
- [x] **Tool list:** 14 tools, no prompt tools, no generic workflow system.
- [x] **Existing tools:** rebuild everything on the shared core; no code carried over.
- [x] **Free-only mode:** one global switch, off by default.
- [x] **Budgets:** user picks Disabled, Warn or Hard stop.
- [x] **History:** prompts and text outputs only; warn before leaving a page with undownloaded results.
- [x] **Hosting:** GitHub Pages, with cross-origin isolation through the service worker for ffmpeg.wasm.
- [x] **Mobile:** desktop first, responsive.
- [x] **Releases:** everything in v1, delivered in stages with test gates.
- [x] **Look and feel:** plain Bootstrap 5.3 with light and dark modes.
- [ ] **Name:** ORtoolbox. Open launch task: before launch, confirm the GitHub repo name is free and check OpenRouter's brand guidelines for using "OR" in a public product name.
