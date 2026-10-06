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
- Home with search, favorites, recent runs and first-run onboarding; Privacy page (39fd198).
- Tool authoring guide and Stage 2 e2e specs (4c42391).
- Settings page: keys and balances, default models and free-only mode, tool bindings, budgets, appearance, passphrase lock, data, backup and restore; every section deep-linkable (d8c959f).
- Models page: searchable, filterable and sortable catalog as cards or table, favorites, recently used, your own stats per model, expiry warnings, comparison of 2 to 4 models, refresh (cb1e30a).
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
- Model arena: one prompt and files to 2–4 models in parallel (one run each, one `groupId`), streamed side by side with time to first token, total time, tokens, tokens/s and cost, a comparison table marking the fastest and cheapest, per-contender Retry, Stop for all; blind voting (shuffled Model A–D, names and costs hidden until a vote or a reveal) with a local tally (Reset with Undo); Markdown/JSON export of a round (56a80b1).
- Stage 7 e2e gate: the arena runs 4 models at once (c5e28e2).
- `mountTool(…, { modelChip: false })` for tools that choose their models themselves (3978bbf; now the manifest field `ownModels`, 7200c1b).
- Decision: text or key-value situation, question builder for Yes/No, Choice and Score (slug ids, criteria, options and a scale reordered by drag or Move buttons, thresholds), answer cards with meter, bars and scale, Clear / Needs review that re-labels without a new run, starter templates, saved deciders with Undo, JSON download and copy, free-only on Mercury Decide (099f5dd, eefc703).
- Model picker help text per capability (`CAPABILITY_INFO.help`), used to say which decision models are verified (95ee388).
- Stage 7 e2e gate for Decision: each question type with Jev, Mercury and thin responses, key-value state as the tutorial request, saved deciders, 429 and Stop, History reopen, 320 px by keyboard (44e6570).
- Bot-to-bot chat: two bots with names, models and personas, framing shown read-only; streamed turns as alternating bubbles with avatars and per-turn tokens, cost and latency; turn, time, cost-cap and stop-phrase limits plus Stop; Pause, Step, Resume, moderator messages, edit and resume with Undo; one run per press with History replay; survives a reload; Markdown and JSON export (ae264ed, 484b833).
- Stage 7 e2e for Bot-to-bot chat: every stop condition, moderation, a failed turn, exports and the prompts round trip (7d15e9f).
- Shared `approxTokens()` in `src/core/tokens.ts` (0575155).
- Stage 7 review, shared UI: `runner.setLabel()`, `runner.addAction()` and `RunnerOptions.hideWhileBusy` for multi-action run bars, `stopOnEscape()` and `composing()` (4a7cacb); `createMarkdownCache()`, `attachmentIntake()` and the `.or-icon-action` button class (cdb6f5f); `describeRunCost()`, `formatRunCost()` and `usageLine()` (6c3967a); `failureText()` with a blind mode for the arena whose failures all read alike (276d460, 2fe9023); manifest field `ownModels` (7200c1b).
- v1 README and user guide (`docs/user-guide.md`: first steps, every tool, platform pages, troubleshooting), with screenshots in `docs/images/` (e29928a).
- `ChatStreamResult.refusal` names a model's refusal or a reply cut by the content filter or an error (f566153); `EstimateInput` tokens take `audio: { input, output }` (1f43772); `isoDateTime()` in `format.ts` (eeece28); `StorageUnavailableError` (46725c8); OAuth's `KeyNotSavedError` with `save()` (03f3b6b).
- Stage 8 framework: `retryGate().retryFailed(error, keys)` (asks before resending a request that may have been billed), `failureLine()`, `ItemOutcome.failure`, `pendingOnly(isDone, allKeys)` for plain-run replays (13f0060); `resultRemoval()`/`confirmUndownloaded()` and `sanitizeSvg()` (fd0aca4); `ui.confirmDiscard()`, `RunnerOptions.stopOnEscape`, Alt+Shift+N to reach a toast's action (b60be68); `ToolTestContext.settle()` (1457b54).
- `budgets.monthSpend()` (the month as budget checks count it, with running runs' holds and the estimated part), `webStorageBlocked()` and a once-per-page notice when the browser blocks saving (1b5cf0c, 0285ce8).

### Changed

- Streams fail after 5 minutes without a byte; a video status read times out after 60 s and is retried (04e84a9).
- Budget checks and the orphan sweep read small per-run holds instead of running records; History search and its model filter no longer rescan or copy whole outputs (84ca07d, 4e53b56).
- Faster first paint: icon font and stylesheet cut to the icons used (134 to 16 KB), Bootstrap without unused components, tool styles loaded per tool page, icon font preloaded; shell CSS 53 to 36 KB gzipped. `npm run icon-subset` regenerates the icons (7352f30).
- Every page has a meta description, from the tool manifest or a page table; the OAuth return page is `noindex` (7352f30).
- `npm run budgets` checks the built JS budgets (shell at most 150 KB gzipped, each tool at most 80 KB more); CI runs it after the build.
- US spelling "Favorites" everywhere (text, test ids, code and the settings fields `favoriteTools` and `models.favorites`); settings saved under the old field names are still read.
- `trimOldest()` in `src/core/tokens.ts` replaces Chat's `trimToBudget` and Bot-to-bot's `trimCount` (94c14cf).
- `RunHandle.reservedUsd`; Model arena says what an unknown cost counted; a group total with unknown members shows "+ N unknown" and budgets treat it as a floor; `beginAll` returns handles in spec order (4f88cad).
- US spelling throughout the UI: color, canceled, centered, labeled, organization and harbor in labels, messages and samples; `tests/lint/us-spelling.test.ts` fails on a British spelling in UI strings, HTML titles and manifests (2fc023b).
- Bot-to-bot chat uses the framework's run bar (Step and Pause as runner actions, Escape through `stopOnEscape`), the shared Markdown cache, cost wording ("cost unknown (≈ $x counted)"), `failureText`, core token counting and `holdLock`; it re-reads its state after a data reset (752fdfe, 41d107d).
- Group budget approvals: `runs.approveGroup()`/`releaseGroup()`, `RunSpec.useGroupApproval` and all-or-none `runs.beginAll()`; the budget dialog names a group with its models and total; Video studio approves its sequences through them (e7660ec).
- A run stopped before it sent anything books no stats row (e7660ec).
- `ToolStateStore.update()` under a per-key Web Lock; `webLocks()`, `lockRunner()` and `holdLock()` in `core/util` (85b2086).
- `CallOptions.onSend` fires right before each request is sent, after throttle and retry waits (5f9cbea).
- One token module, `src/core/tokens.ts`: `approxTokens` counts digits and punctuation higher (JSON and code), plus `fitContext()`, `promptBudget()` and `outputTokens()`; Chat uses them (5259647).
- `trimMedia` takes `fadeOut` and `bitrate` for audio cuts (da8b7b9).
- Image estimates treat a zero catalog price as unknown, not free (f6af99d).
- Video estimates take an `images` count and add per-image input prices (`cents_per_image_input`) (e7aaee5).
- Video studio uses the framework's job cost (`usage`), `run.cancel()` for "Stop waiting" (History shows it stopped at once), opt-in job notifications (one per sequence), `outcomeUnknown` (no Retry toast) and `videoResultCard`; a sequence step the provider failed no longer counts against the spend cap (9fb1171).
- Image pipeline: opt-in `adaptThreshold` (threshold kept below the picture's own background and noise) and `despeckle` (background filled on the picture and small light specks removed before the product box); `IsolateResult.threshold` (fdb6368).
- The primary runner stops on Escape by default; image and audio result cards ask before removing a result not downloaded, like video (13f0060, fd0aca4).
- `createToolTestContext().cleanup()` is async: it stops runs, waits for tool-state writes and leaves the bus (1457b54).
- The palette lists every tool and page while the search is empty (b4cd175).

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
- Chat's attachment logic moved to `src/core/attachments/` (kinds, limits, reading, content parts, parser text, token approximation, missing-input checks, parser add-on) and the chip to `attachmentChip()`, shared with Model arena (41e1cbb).
- Stage 7 review, shared UI: Chat uses the shared Markdown cache, attachment intake, `stopOnEscape()`, `usageLine()` and `.or-icon-action` (5252825); `checkText()` takes the noun ("message" or "prompt"); Settings → Tools shows "Chosen inside the tool" for Model arena and Bot-to-bot instead of a model picker, and `mountTool(…, { modelChip: false })` is the manifest's `ownModels` (7200c1b); History words costs through `describeRunCost()` and names what budgets counted for an unknown cost (6c3967a); the runner hands focus on when the focused bar control hides (4a7cacb).

### Fixed

- Backup Replace keeps running runs, open jobs, jobs of a running run and those tools' saved state, and says what it kept (1b5cf0c, 0285ce8).
- Settings → Budgets meters read the month once, include what running runs hold and mark estimates with ≈ like Stats (1b5cf0c, 0285ce8).
- A stored run or prompt with an impossible time no longer breaks Home, History, Models or the prompts panel; a run of a removed tool no longer breaks History, Home, the palette or a job's notification (0285ce8).
- `presentError` explains a browser that blocks saving; delete dialogs name what they kept; onboarding no longer says every tool has a "Run" button; Undo texts no longer promise "a few seconds" (0285ce8).
- Video studio: Pause, Stop and a failed step no longer abort a paid request already past its last check; a spend cap of 0 or less is refused instead of lifting the cap; failed store writes, a clip that cannot be placed and a missing run record are shown; system pauses and blockers are announced; frame pickers are not "(optional)"; Extend is off for a clip that is not ready; a dropped video no longer changes the hidden One clip mode (f51c2be).
- Decision: a failed write of a paid answer no longer turns it into "Failed" with a Retry; renaming a saved decider keeps another tab's save; templates start at the starting threshold; one wording for the review count (f51c2be).
- Bot-to-bot: a streaming turn is stored as it speaks, and a refusal is shown as the turn's outcome (f51c2be).
- Model arena: exports keep model text out of their structure (shared `safeBlock`); tally Reset and Undo use the stored tally; a refusal fails its panel; a stopped contender has Retry; "All bad" is in the tally (f51c2be).
- Backup merge keeps the newer saved and recent prompts (`usedAt`) and tool state (`updatedAt`) instead of always taking the backup's, merges favorites saved under the old British names, and skips records with times no date can hold (eeece28).
- An older tab never writes over a keys file of another version or with an unreadable lock, and keeps key entries it cannot parse (83a06e4).
- "Connect with OpenRouter" keeps a new key it could not save (locked meanwhile, storage full) and offers to save it, instead of losing it (03f3b6b).
- Passphrases are NFC-normalized; the strength hint asks for 16+ characters or four words (6fba1c1).
- Privacy page and lock settings no longer claim closing the tab locks the keys, and say that Chat keeps attached text and PDF text (c365873).
- Two tabs no longer refetch the model catalog from each other when IndexedDB writes fail (dadff39).
- Chat replies that are refusals or were filtered are no longer silently empty (f566153).
- Estimates: zero prices on non-`:free` models are unknown, not free; reference images and audio are priced high (1f43772).
- Blocked localStorage is reported instead of faking a save; IndexedDB quota errors show the storage-full help (46725c8).
- A run orphaned with a request in flight books its reservation; one with nothing in flight books exactly its stored cost; a handed-off one books what its job stored (84ca07d).
- A paid request answered 408 or 5xx (not 503), or with an error in a 200 body, books an unknown cost and is never re-sent; failed `/images` generations stay unbilled, as documented (04e84a9).
- Error codes such as `failed_to_generate` no longer read as rate limits and retry (04e84a9).
- A job taken over by another tab never books its cost twice; a job still running after 3 hours is given up with its reservation booked (84ca07d).
- A Stop that arrives while a model arena round is starting is no longer lost (84ca07d).
- A Stop during an image stream keeps the completed, billed images (`partialImageResult`) (04e84a9).
- Deleting history or tool data keeps runs and jobs in progress, so their spend is still booked; a per-tool delete also removes the tool's saved state (4e53b56).
- `beginRun({ model })` books that model's estimate, so the per-run limit applies (c382456).
- A batch where every item failed and one may have been billed now shows the runner's caution instead of staying quiet; inline failures and the output panel keep that caution (13f0060).
- The error toast's Retry after a failure part-way can skip finished items of a plain run, and says why when it cannot start (13f0060).
- OpenRouter's specific 402 and 429 messages are no longer replaced by generic ones; the rate-limit toast no longer talks only about free models (13f0060).
- Reloading or closing a tab during a run asks first (13f0060).
- The same status line is announced once, not three times (13f0060).
- Removing the last audio take no longer loses focus (fd0aca4).
- SVG results are saved sanitized (no scripts, no external links) or as PNG (fd0aca4).
- Tool pages no longer shift while the tool sets itself up; the Run bar no longer scrolls controls beside it or in dialogs; Shift+Tab never leaves focus under the navbar; toasts no longer cover Run and Stop on phones; `.tsx`, `.vue` and `.kt` files dropped on Chat are no longer skipped (b60be68).
- History stops filtering by a key that was removed; Home words estimated costs with ≈; the Budgets help explains group totals; Enter that confirms an IME composition no longer acts in the palette or Home's search; revealing a document page respects reduced motion (b4cd175).
- Tool unit tests no longer write into the next test's database (1457b54).

- The sticky Run bar no longer covers a control focused by Tab when the page scrolls smoothly to it: the framework checks again once the scroll ends (d8e6d0c).
- The first-visit isolation reload no longer happens once the user has started using the page, keeps the parameters the tool already consumed, and never happens on a Send to page (942ff57).
- After a deploy, a page whose lazy chunk is gone offers a reload; pages served from the cache find their lazy chunks precached (942ff57, a2622e3).
- The service worker no longer re-writes whole cache entries (the 32 MB ffmpeg core included) to record their last use (a2622e3).
- Reset everything can no longer be undone by a tool-state write already on its way: the guard runs inside each write's transaction against a reset generation that Reset bumps while it wipes; Bot-to-bot's extra delete is gone (2271fcd).
- Model arena: a round asks one budget question for its total and starts all or none (`beginAll`; a declined dialog sends nothing); first token and total are timed from `onSend`; blind errors use `failureText` (no 402/429 or name differences); costs through `formatRunCost`; files through `attachmentIntake`; context fit from `src/core/tokens.ts`; the tally through `ctx.state.update` (3bbe92e).
- Decision: a badge now agrees with the number beside it (Yes/No confidence float noise; no "100%" for 0.9999999995), an id typed with a trailing space finds its answer, a list you emptied stays empty, and the context check no longer refuses long prose that fits (2bdff81).
- Decision: dropping a scale level clears the drag, focuses the level that moved and no longer carries `text/plain`; renamed questions and thresholds edited during a request keep their cards; key-value runs record what was sent as their prompt; Load asks before replacing a different situation; empty drops change nothing; Markdown, CSV, JSON, logs and YAML are accepted (e344b35).
- Stage 7 review, Model arena: blind rounds leak nothing through errors (one billing note for every failed panel, every form of the model's name removed) or History (no panel letter); voting and export close while a Retry is pending, and export waits until every answer is in; a full tie marks no Fastest or Cheapest; stopped or usage-less answers show "—" tokens, and no tokens/s with hidden reasoning; cut-off answers are marked; optional Max tokens is sent and estimated; a round takes its input when Compare is pressed; `?model=` without a round is kept; the tables keep focus; tokens are counted once per refresh; the Markdown export closes open code fences (4f16fe3).
- Stage 7 review, Bot-to-bot chat: an empty reply is a failed turn instead of being asked again; a turn that may have been billed warns without Retry; a conversation too long for the model is refused before the run; one tool-wide lock, so another tab's run blocks changes here and a run adopts a newer stored version; a data reset is never written back; the stop phrase counts only at the end of a message; a time limit changed mid-turn re-arms; a $0 cap wording; renamed bots labelled by their current name; the Markdown transcript closes open code fences and escapes headings; Ctrl+Enter runs with the limits as typed; loaded setups are not saved and set aside a conversation with another opener; an open edit survives Resume; focus after Undo; stat tiles wrap; auto-follow after big renders (d64e43f, 7ce80f5).
- Stage 7 review, core: a group of runs is checked against its total, and its dialog no longer shows only the first member's estimate (e7660ec); an open page can no longer undo Reset everything by writing its old state back, and open tools re-read their state after a reset, Delete all or a backup import (ff3f29e).
- Video joins stay within what the browser can allocate (`MAX_JOIN_BYTES`); a result button no longer subscribes again on every redraw (5680493).
- Stage 6 review, Video studio: a sequence asks one budget question at Start for its total (steps run without dialogs of their own); form edits reach the stored run field by field (no stale form overwrites another tab's cap) and are flushed before Resume and Re-run; Pause, Stop and the cap stop a step that is starting; maybe-billed steps count against the cap ("≈"); clip placement and step completion are one idempotent update, re-runs are attempts, stale chained takes are marked; a lost clip to continue or lost step images pause with choices instead of a text-only send; polling no longer downloads, an expired clip is marked; no blind Retry after a request that may have been sent; the History record is the form as pressed; trims, seed, reorder, join and frame grabber focus and feedback; the frame grabber uses the clip's own frame rate.
- Stage 5 review, Isolated image: JPGs keep at least 24 px of white and their decoded border is part of the QA; the automatic threshold reads the lightest border population (a pale product can no longer lower it to its own value; an unreadable background is flagged); despeckle removes only compact specks (thin lines, threads and beads stay); a replayed Retry skips photos already made; results finishing after a pattern change get the new name; the review's margin and Previous/Next stay in step; focus and announcements (dab4103, a4cf3b0).
- The sticky Run bar no longer hides the focused control; image result cards focus after removal, never mislabel an unencodable WebP and download SVG as is; the image worker survives a failure and never falls back on a detached buffer; EXIF-rotated references are re-encoded upright (b087039, 40d07ca, e3734d5).
- Audio player seeks in recordings whose duration reads as Infinity; a single segment already in the target format is not re-encoded (ed3a51f). E2E: shared abort filtering in `watchForProblems`, chat reloads wait for stored replies, two load-sensitive unit tests made steady (53646cf).
- Stats: the ledger counts a multi-model run as one run and one error, and tracks the estimated part of spend (shown as ≈ on the page); relative ranges roll over at UTC midnight; a series hidden in a chart comes back when its legend goes away; the tooltip names the hovered day when nothing happened on it; one ledger read per load.
- History: runs in progress are never deleted (and Undo cannot bring one back); the model filter comes from the runs (routed ids included); JSON output keeps big numbers and every value as stored; "Show more" appends rows.
- Models: one price model (`src/ui/model-price.ts`) for the picker, tool chip, Settings and the page, in each model's real billing unit; sorting and the price limit compare like with like; usage from one ledger read.
- Small targets are at least 24 × 24 px and page classes no longer collide with Settings.
- Stage 7 review, shared UI: Ctrl, Cmd and Alt+Escape no longer stop a Chat reply (4a7cacb); a Chat reply whose request may have gone through and been billed shows that caution and a link to OpenRouter's activity instead of a Retry that could pay twice, and keeps it across reloads (5252825); the model picker's help text is linked to its search field (8287a8b).

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

### Security

- Model Markdown keeps only an attribute allowlist: no classes, `data-*`, ARIA, `hidden`, `tabindex`, `for` or `popovertarget`, which let output draw fake dialogs, hide copied text or drive page controls (e4d1520).
- The service worker verifies every cached file against a SHA-256 from the build at install, fill and serve, so another site on the shared host cannot plant code in its caches (a2622e3).
- CSP as a real header on documents (`frame-ancestors 'none'`) and worker scripts; framed pages are hidden (a2622e3, 9567822).
- CI pins actions to commit SHAs, keeps no checkout credentials, installs without scripts for the deployed build; Dependabot added (de4c835).
- Third-party notices (`licenses.txt` in the site, `THIRD-PARTY-NOTICES.txt` in the repository), with the source of the GPL ffmpeg.wasm cores (44ac59e).
