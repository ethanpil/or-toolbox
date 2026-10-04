# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Jobs book their cost on success (`usage`), tell provider failures from giving up (`failureKind`), notify only on request (`notify`); `run.cancel()`; unknown-outcome errors with `safeAction`; `videoResultCard()` (997d5a1, b264fe9, 5680493).
- Image framework: `models.imageControls()` (one policy for image models), `referencePicker()`, shared `compareSlider()`, `toDataUrls()` and `readImageSize()`, worker ops for mask work, `promptless` tools, `replayArg`/`pendingOnly()` for retries, image estimates per request (0b66b70, b087039, 40d07ca, e3734d5).
- Tool framework for the audio stages: `ui.holdWork()` (leave guard for unsaved in-memory work), `ui.progress()` (quiet counters), `retryGate()`, `progressBar()`, `audioResultCard()` and a shared `transcode()`; estimates are computed afresh at run start (20ea0ec, bca3f9f, ed3a51f).
- Vite multi-page build of 22 pages under `/or-toolbox/`, with strict TypeScript, ESLint, Prettier, Vitest and Playwright (a76487c).
- Shared page head with CSP meta tag, pre-paint theme script, PWA manifest and generated icons (a76487c).
- Manifests, registry and placeholder pages for all 14 tools (a76487c).
- Core helpers `url()`, `h()` and sanitised `renderMarkdown()` (a76487c).
- Service worker for cross-origin isolation and an offline shell (a76487c).
- Self-hosted ffmpeg.wasm loader and a diagnostics page with an ffmpeg smoke test (a76487c).
- Mocked OpenRouter, Stage 0 gate tests and GitHub Actions workflows (a76487c).
- OpenRouter API reference and recorded fixtures from paid probes (b5596a4).
- Core contract: typed service interfaces, storage schema, passphrase crypto (0bc775e).
- OpenRouter API client with streaming, retries and a free-model throttle (bedd06f).
- Model catalog with offline cache, shipped defaults and cost estimates (3388801).
- API keys with passphrase lock, and Connect with OpenRouter (PKCE) (60532b6).
- Core state: cross-tab bus, settings, tool state, session results with leave-page guard (73f1342).
- Core state: runs, budgets, stats, history, prompts, jobs, backup/restore, data management (6bbe169).
- Media processing: image isolation pipeline, frame capture, audio decode/split, ffmpeg join/trim/transcode, PDF rendering (bb2d9f6).
- Exporters: CSV, TSV, XLSX, DOCX, SRT, VTT, ZIP (55a35a4).
- Composition root `getCore()` (c8da141).
- Gapless audio stitching and an off-main-thread image pipeline (Stage 1 review).
- Page shell `mountPage()`: navbar with tools menu, key chip and balance, lock, theme and free-only badge; command palette (Ctrl/Cmd+K); leave-page guard; budget confirmation; live accent colour, density and reduced motion (a94c4fe).
- Feedback: toasts with Undo, confirm, typed-confirm, prompt and unlock dialogs, `presentError()` per error code (a94c4fe).
- Shared components: drop zone, model and key pickers, cost badge, prompts panel, output panel, export menu, image, audio and video players, job list (3dd8a33).
- Tool framework `mountTool()`: header chips, three-zone layout, Run/Stop, URL state, drop and paste, Send to…; all 14 tools mount through it (0e06dde).
- Home with search, favourites, recent runs and first-run onboarding; Privacy page (39fd198).
- Tool authoring guide and Stage 2 e2e specs (4c42391).
- Settings page: keys and balances, default models and free-only mode, tool bindings, budgets, appearance, passphrase lock, data, backup and restore; every section deep-linkable (d8c959f).
- Models page: searchable, filterable and sortable catalog as cards or table, favourites, recently used, your own stats per model, expiry warnings, comparison of 2 to 4 models, refresh (cb1e30a).
- History page: timeline by day with search and filters, run detail drawer (reopen, re-run with another model, star, copy, export, delete with Undo), bulk export and delete, live updates, `?tool=` and `?run=` links (d7fdb94).
- Stats page: KPI tiles, spend, requests and tokens charts (Chart.js, loaded on demand, light and dark, table view for each), breakdowns by tool, model and key, budget burn-down, key balances and free requests today (1f5ecd7).
- `HistoryService.restore()` for Undo (d7fdb94).
- Shared `documentInput()` for images and PDFs (lazy thumbnails, page ranges like `1-3, 7`, pages loaded one at a time for upload) and `runPool()` (6d07e24).
- OCR: printed, handwriting, math and layout modes, pages read three at a time with streaming, per-page retry and Stop, OpenRouter's PDF parser as an option, Markdown/text/Word exports (7e24c06).
- Data extractor: visual schema builder with five presets and saved schemas, batch extraction with strict structured outputs (JSON mode and one repair otherwise), editable review grid, JSON, CSV and XLSX exports (a83381c).
- Table extractor: tables and charts per page into editable grids with merge across pages; CSV, ZIP, XLSX and Markdown exports, copy as TSV (25d06e2).
- Stage 3 e2e gates for the document tools, a 20-page PDF fixture with its generator, and `mock.respond()` for request-dependent mocks.
- Framework for batch and multi-model tools: `runner.trigger(arg)` with Retry replaying the argument, `runItems()` batches, `RunSpec.addons` and `ToolInstance.addons()` for paid extras with one PDF engine table, `run.checkpoint({ output: () => text })`, `streamMarkdown()`, `exportMenu().update()`, `focusKey()`/`focusedKey()` and `replaceWith()` (08eb65c, cac4ab0, a60a24a, 7bcb412).
- Chat tool: branching threads (edit and regenerate keep the old branch, ‹ 1/3 ›), per-chat model switch, fallback models, image/PDF/audio/text attachments, system prompt presets, reasoning effort, streamed Markdown replies with tokens, cost and latency, context trimming, Markdown and JSON export, thread search, rename and delete with Undo (b820a75, 90fa95b, fef8d74).
- Speech-to-text tool: microphone recording and audio/video files; long recordings cut at pauses and merged with continuous timestamps, per-part retry and Stop; speaker labels (Deepgram, MAI-Transcribe) and key terms where supported; editable transcript that follows playback, speaker renaming, search; TXT, SRT, VTT, JSON and Word exports; Stage 4 gate for a 60-minute recording (fdcb324, 1df5345, fb49433).
- Text-to-speech: voices from `supported_voices` with readable names and cached previews (cost shown, free on the free Fish model), speed where known to work, TXT/MD input (Markdown read into plain text), long text split at paragraph, sentence (CJK included), clause and word boundaries and read three parts at a time, joined gaplessly into one MP3 or WAV, per-part retry and Stop, MP3/WAV downloads (ecd0144).
- Music generation: song form with a lyrics editor (section tags, validation), reference image, Lyria 3 Clip/Pro choice with prices, 1–3 variations side by side in one run, streamed MP3 with timed lyrics that follow playback, a target length cut in the browser with a fade-out, MP3/WAV downloads (7f76ad8).
- Stage 4 e2e gates for the audio tools: a 10,000-word text joined with no gaps (MP3 and PCM parts), a Lyria stream into a playable, trimmable MP3.
- `imageResultCard()` (viewer, PNG/JPG/WebP downloads, Send to…, actions, Remove) and `imageModelControls()` for `/images/models` parameters (f6af99d).
- Image generation: model-aware controls (aspect chips, resolution, size, quality, format, transparency, seed lock), 1–4 images per run, reference images, streamed partial previews, a gallery with Variations, Use as reference and Edit in Image editor (d383513).
- Image editor: painted masks (brush, eraser, undo/redo, invert, zoom/pan, keyboard), Inpaint, Outpaint and Whole image through marked-up references, "Keep outside the mask" compositing, version history; Stage 5 mask round-trip gate (5d90742).
- Isolated image: product photos edited on `/images` (data-URL reference, fixed instruction, soft shadow on request), post-processed in the worker onto a pure white square with a QA verdict and reason per photo; review with a before/after slider, side by side, per-photo margin and threshold without a new request; retry, retry with another model; JPG/PNG downloads and a ZIP with a file name pattern (aa282c3).
- Stage 5 e2e gate for Isolated image: 20 synthetic photos with imperfect mocked isolations, all passing QA, the ZIP of 20 JPGs checked pixel by pixel (ccc8999).
- Video studio: model-aware form from `/videos/models`; text, first frame, first + last frame and reference modes; Continue from a clip's true last frame (uploads included) and native extend with a public HTTPS link (else Continue); persisted jobs with hand-off and cost booking; auto-extend sequences (chained or 3 at once, repeat, style, spend cap, stop/skip, pause/resume, re-run) that resume after a reload; frame grabber; timeline with reorder, trims, dropped repeated first frames and an ffmpeg join with Stop (cfb9c20).
- Stage 6 e2e gate: a 5-step chained sequence survives a reload, joins into an MP4 that plays; a spend cap stops a sequence (0ec6971).
- Bot-to-bot chat: two bots with names, models and personas, framing shown read-only; streamed turns as alternating bubbles with avatars and per-turn tokens, cost and latency; turn, time, cost-cap and stop-phrase limits plus Stop; Pause, Step, Resume, moderator messages, edit and resume with Undo; one run per press with History replay; survives a reload; Markdown and JSON export (ae264ed, 484b833).
- Stage 7 e2e for Bot-to-bot chat: every stop condition, moderation, a failed turn, exports and the prompts round trip (7d15e9f).
- Shared `approxTokens()` in `src/core/tokens.ts` (0575155).

### Changed

- `trimMedia` takes `fadeOut` and `bitrate` for audio cuts (da8b7b9).
- Image estimates treat a zero catalog price as unknown, not free (f6af99d).
- Video estimates take an `images` count and add per-image input prices (`cents_per_image_input`) (e7aaee5).
- Image pipeline: opt-in `adaptThreshold` (threshold kept below the picture's own background and noise) and `despeckle` (background filled on the picture and small light specks removed before the product box); `IsolateResult.threshold` (fdb6368).

- Stage 0 review fixes: COEP `require-corp` only, isolation reload limited to pages that need threads, manifest-based offline shell, hardened `h()` and Markdown sanitising, dev-server CSP and isolation, TypeScript 6, single gated CI pipeline (cb1cc69).
- Errors share one `OrError` base with codes; shared helpers moved to `util.ts` (6b469ef).
- Budgets count reservations of running runs; unknown costs book the reservation (Stage 1 review).
- Stats survive "Delete all prompts and history" (c8da141).
- Auto-lock 0 means never (82808cd).
- OAuth callback, Diagnostics, Settings, Models, History and Stats render on the shell (39fd198).
- `models.resolve`: `?model=` and tool bindings apply to a tool's primary capability only (5072110).
- Tool framework: `ToolInstance.estimate()` with `ui.refreshEstimate()`, one error rule through `output.fail(error)`, `createToolTestContext()`, `data-testid="tool-prompt"` convention (9760b10).
- One modal at a time (queued), toasts with actions never auto-hide, `setFieldError()` for field errors (1db3bfd); re-renders keep focus through `data-focus-key` (20bdddc).
- Platform pages share small helpers instead of per-page copies (star button, data table, key balance view, `loadInto`, `copyWithToast`, `saveSettings`, `formatInt`/`formatDate`, `debounce`, one `CAPABILITY_INFO`); Settings builds a section when first shown; model search is debounced with cached normalised fields; `/` and Ctrl/Cmd+K respect dialogs and fields (b4948b5, 240f925, 78749a9).
- `exportMenu` formats may set their own file name (6d07e24).
- `replace()` falls back to the nearest keyed control when the focused one is gone or disabled; `documentInput` updates page tiles in place and opens each added PDF once (a60a24a).
- `ChatStreamResult.annotations` (the PDF parser's text) and a `tool-state-changed` bus event from the tool state store (99eae10); Chat streams its PDF turns, hears other tabs on the bus, and uses the runner argument, `streamMarkdown`, PDF add-ons and the focus helpers (81fc471).
- CSV/TSV keep phone-like values (`+44 20 7946 0958`) as written (c6d74d2).
- File types: untyped source files (`.py`, `.yaml`, `.js`…) get `text/x-*` types, so `text/*` tools take them (5afda1e).

### Fixed

- Video joins stay within what the browser can allocate (`MAX_JOIN_BYTES`); a result button no longer subscribes again on every redraw (5680493).
- Stage 6 review, Video studio: a sequence asks one budget question at Start for its total (steps run without dialogs of their own); form edits reach the stored run field by field (no stale form overwrites another tab's cap) and are flushed before Resume and Re-run; Pause, Stop and the cap stop a step that is starting; maybe-billed steps count against the cap ("≈"); clip placement and step completion are one idempotent update, re-runs are attempts, stale chained takes are marked; a lost clip to continue or lost step images pause with choices instead of a text-only send; polling no longer downloads, an expired clip is marked; no blind Retry after a request that may have been sent; the History record is the form as pressed; trims, seed, reorder, join and frame grabber focus and feedback; the frame grabber uses the clip's own frame rate.
- Stage 5 review, Isolated image: JPGs keep at least 24 px of white and their decoded border is part of the QA; the automatic threshold reads the lightest border population (a pale product can no longer lower it to its own value; an unreadable background is flagged); despeckle removes only compact specks (thin lines, threads and beads stay); a replayed Retry skips photos already made; results finishing after a pattern change get the new name; the review's margin and Previous/Next stay in step; focus and announcements (dab4103, a4cf3b0).
- The sticky Run bar no longer hides the focused control; image result cards focus after removal, never mislabel an unencodable WebP and download SVG as is; the image worker survives a failure and never falls back on a detached buffer; EXIF-rotated references are re-encoded upright (b087039, 40d07ca, e3734d5).
- Audio player seeks in recordings whose duration reads as Infinity; a single segment already in the target format is not re-encoded (ed3a51f). E2E: shared abort filtering in `watchForProblems`, chat reloads wait for stored replies, two load-sensitive unit tests made steady (53646cf).
- Stats: the ledger counts a multi-model run as one run and one error, and tracks the estimated part of spend (shown as ≈ on the page); relative ranges roll over at UTC midnight; a series hidden in a chart comes back when its legend goes away; the tooltip names the hovered day when nothing happened on it; one ledger read per load.
- History: runs in progress are never deleted (and Undo cannot bring one back); the model filter comes from the runs (routed ids included); JSON output keeps big numbers and every value as stored; "Show more" appends rows.
- Models: one price model (`src/ui/model-price.ts`) for the picker, tool chip, Settings and the page, in each model's real billing unit; sorting and the price limit compare like with like; usage from one ledger read.
- Small targets are at least 24 × 24 px and page classes no longer collide with Settings.

- Stage 1 review: orphaned runs, double-booked and lost spend, retried paid POSTs, OAuth while locked, stale unlock sessions, non-atomic backup import, CSV formula injection, invalid XLSX/DOCX output, WAV/MP3/video edge cases.
- Stage 2 review, shared parts: orphans that sent nothing no longer book their reservation, Undo never restores a running run (5072110); duplicate budget and add-key dialogs, offcanvas focus trap lost under a dialog (1db3bfd); accent contrast on cards and canvas, weak dark-mode focus border (9f3d343); stalled streaming, leaking result buttons, waveform memory, stray drops leaving the page (9760b10); inaccurate privacy copy, stale Home state (9f0ce68).
- Stage 3 review, Chat: Undo of a deleted branch restored a stale snapshot; tabs overwrote each other's threads; PDFs were uploaded and parsed again on every turn; Mistral OCR ran in free-only mode; `max_tokens` and oversized messages were not checked against the model; "via" hid dated snapshots; the estimate ignored dearer fallbacks; Enter and Escape fired during IME composition; the conversation was a live region rebuilt on every update and lost focus; attachment bytes were never released (d330934).
- Stage 2 polish regressions: History drawer keeps focus on Output/Prompt; key balances load once and survive a failed refresh; the free counter asks only the default key; failed History and Home searches show the error; passphrase errors are announced once; Diagnostics storage in MB; dev specs use the page's own core at default timeouts (7cfa6a8).
- Stage 4 review, Text-to-speech: a failed or stopped join keeps the paid parts ("Join again"), bad parts are remade alone, Retry and Read aloud continue an unfinished plan instead of paying again, parts are about 60 s of speech per script and speed (Seed Audio's 120 s cap), Markdown stripping keeps intros and literal `*`/`_` and drops script/style, previews speak the voice's language (9999fc7).
- Stage 4 review, Music: a song already received survives a dropped stream (`partialStreamResult`, e625ee0), a bad reference image no longer leaves stuck cards, cut songs hide lyrics past the cut, refusals show Lyria's text, tag buttons keep the selection and native undo, one song plays at a time (bf3ed98).
- Stage 4 review, Speech-to-text: seam de-duplication only within real overlaps and keeps combining marks, a vanished microphone falls back to the default, Retry checks the model and the recording, the editor updates in place, models with format rules always get decoded WAV, the level meter respects reduced motion and warns on silence (wt-s4-sttfix).
- Stage 5 review, Image generation: a locked seed is always the seed sent and re-runs reproduce it; images missing from a partial answer get a failed card with Retry; Retry errors that need an action reach the shell's dialog; SVG results download as-is; transparency forces PNG/WebP (b008b1c).
- Stage 5 review, Image editor: no grey halo on outpaint; edits block loading, version changes and painting while they run; references from upright pixels at one size with an instruction matching what is sent; very large pictures scaled down on load; results of another shape fitted, not stretched; Ctrl/⌘+wheel zoom honours deltaMode; brush and mask coverage announced (0c0ae9b).
- Stage 5 review, Isolated image: exported JPGs keep a 24 px white border and are re-checked after encoding; despeckle spares thin and pale product details; the threshold is read from the background, not the product; a replayed Retry skips photos already made; names follow the current pattern; review controls stay in sync (dab4103, a4cf3b0). It now builds on the shared image parts (`imageResultCard`, `imageThumbnail`, `imageControls`, `pendingOnly`, `readImageSize`, `compareSlider`) and is promptless: the notes field is gone, Prompts saves settings presets (8127cd6).
- Stage 4 review, shared: `ui.holdWork` protects unsaved in-memory work, `ui.progress` for quiet counters, fresh estimates at run start, shared `retryGate`, `progressBar`, `audioResultCard` and `transcode` (20ea0ec..fead852).

### Removed

- `write-excel-file` dependency; XLSX is written directly (472888c).
- Stage 0 placeholder frame `src/ui/stub.ts` (39fd198).
