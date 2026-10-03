# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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

### Changed

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

### Fixed

- Stats: the ledger counts a multi-model run as one run and one error, and tracks the estimated part of spend (shown as ≈ on the page); relative ranges roll over at UTC midnight; a series hidden in a chart comes back when its legend goes away; the tooltip names the hovered day when nothing happened on it; one ledger read per load.
- History: runs in progress are never deleted (and Undo cannot bring one back); the model filter comes from the runs (routed ids included); JSON output keeps big numbers and every value as stored; "Show more" appends rows.
- Models: one price model (`src/ui/model-price.ts`) for the picker, tool chip, Settings and the page, in each model's real billing unit; sorting and the price limit compare like with like; usage from one ledger read.
- Small targets are at least 24 × 24 px and page classes no longer collide with Settings.

- Stage 1 review: orphaned runs, double-booked and lost spend, retried paid POSTs, OAuth while locked, stale unlock sessions, non-atomic backup import, CSV formula injection, invalid XLSX/DOCX output, WAV/MP3/video edge cases.
- Stage 2 review, shared parts: orphans that sent nothing no longer book their reservation, Undo never restores a running run (5072110); duplicate budget and add-key dialogs, offcanvas focus trap lost under a dialog (1db3bfd); accent contrast on cards and canvas, weak dark-mode focus border (9f3d343); stalled streaming, leaking result buttons, waveform memory, stray drops leaving the page (9760b10); inaccurate privacy copy, stale Home state (9f0ce68).

### Removed

- `write-excel-file` dependency; XLSX is written directly (472888c).
- Stage 0 placeholder frame `src/ui/stub.ts` (39fd198).
