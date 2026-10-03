# ORtoolbox — developer and agent guide

Browser-only toolbox of 14 AI tools on top of OpenRouter. No server, no accounts. The product spec is [PLAN.md](PLAN.md); the OpenRouter API facts we code against are in [docs/openrouter-api.md](docs/openrouter-api.md). Read both before changing behaviour. This file records the architecture rules and the non-obvious decisions.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on :5273 under `/or-toolbox/` (no service worker; sends the isolation headers itself and a dev CSP built from the production table) |
| `npm run build` | Typecheck + production build to `dist/` (also emits `sw.js` and copies the ffmpeg cores) |
| `npm run preview` | Serve `dist/` on :4273 (service worker and CSP active) |
| `npm run check` | Typecheck + lint + unit tests — run before reporting any work done |
| `npm run typecheck` / `lint` / `format` | `tsc` on the three projects / ESLint + Prettier check / Prettier write |
| `npm run test` | Vitest unit tests |
| `npm run e2e:dev -- <spec>` | Playwright against the dev server (reuses a running one) — use this while developing |
| `npm run e2e` | Build, then Playwright against `preview` — the gate run; do not run it while other agents are working (it rewrites `dist/`). `E2E_SKIP_BROWSERS=firefox` leaves out a browser this machine cannot run; CI never sets it |
| `npm run icons` | Regenerate `public/icons/*.png` and `favicon.ico` from `public/icons/logo.svg` (outputs are committed) |

## Layout

```
index.html, settings/, models/, history/, stats/, privacy/, diagnostics/,  platform pages (tiny HTML entry each:
auth/callback/                                                             <title>, <div id="app">, one module script)
tools/<id>/index.html                                                     one page per tool
src/core/        api, settings, keys, models, budgets, history, prompts, jobs, stats, media, backup, bus
                 (today: boot.ts, paths.ts, sw-register.ts, media/ffmpeg.ts)
src/ui/          dom helpers, shell (navbar, theme, palette, toasts, modals), shared components, tool-page
                 (today: dom.ts, markdown.ts, stub.ts — the Stage 0 placeholder frame, delete in Stage 2)
src/tools/<id>/  manifest.json + main.ts (+ tool-local modules and tests); registry.ts + types.ts beside them
src/pages/       code for the platform pages
src/styles/      main.scss (Bootstrap + Bootstrap Icons + the few variable overrides in _variables.scss)
src/sw/          the single service worker (sw.ts)
public/          theme-init.js, manifest.webmanifest, icons/, .nojekyll — copied to dist/ as-is
vite-plugins/    page discovery, shared <head> + CSP, ffmpeg core copying, service worker build, ports/base
scripts/         one-off generators (icons)
tests/e2e/       Playwright specs (sw/ = service-worker specs)   tests/mock/  mocked OpenRouter   tests/fixtures/  recorded/documented responses and media
tests/lint/      proof that the ESLint architecture rules fire
```

Adding a page = adding a folder with an `index.html`; the build, dev server and route tests all discover it (`vite-plugins/pages.ts`). The shared `<head>` (charset, CSP, viewport, theme colour, manifest, icons, `theme-init.js`, the stylesheet) is injected by `vite-plugins/html-head.ts`; HTML entries must not repeat it.

TypeScript is three projects behind a solution-style `tsconfig.json`: `tsconfig.app.json` (src/, DOM), `tsconfig.sw.json` (src/sw/, WebWorker), `tsconfig.node.json` (configs, vite-plugins/, tests/e2e, tests/mock, tests/lint; imports use `.ts` extensions).

Tool ids (also the URL segment): `chat`, `ocr`, `data-extractor`, `table-extractor`, `speech-to-text`, `text-to-speech`, `music-generation`, `image-generation`, `image-editor`, `isolated-image`, `video-studio`, `decision`, `bot-to-bot`, `model-arena`.

Capabilities (keys for default models): `text`, `vision`, `image`, `tts`, `stt`, `video`, `music`, `decisions`.

## Architecture rules

1. **Pages never call OpenRouter or storage directly.** Tools and pages go through `src/core`. Only `src/core/api` may `fetch` openrouter.ai; only `src/core` may touch `localStorage`, `sessionStorage` or IndexedDB. This is what keeps keys, budgets, cost tracking and history consistent.
2. **Every model call belongs to a run.** A tool starts a run through the context (`ctx.runs`), which applies free-only mode and budgets before the request, captures usage/cost from every response, writes text-only history and feeds stats. Never call the API outside a run except for catalog/key/status reads.
3. **History is text only.** Images, audio, video and uploaded files stay in memory and are registered with the leave-page guard until downloaded. Never write binaries to IndexedDB or localStorage.
4. **Tool contract.** `src/tools/<id>/manifest.json` describes the tool; the shape is `ToolManifest` in `src/tools/types.ts` (PLAN.md's example plus a one-line `description`, minus `entry`, which the folder convention makes redundant; `capabilities` use the list above). `src/tools/registry.ts` collects and validates the manifests. `main.ts` calls `mountTool(manifest, mount)` and receives one context object (Stage 0 stubs call `renderToolStub()` instead). Tools use the shared components (drop zone, model picker, key chip, cost estimate, prompts panel, output panel, players, exporters) instead of rebuilding them. A tool folder may not import from another tool folder; shared code moves to `src/core` or `src/ui`.
5. **Three-zone tool layout:** input left, output right, settings in an offcanvas drawer; advanced options in an accordion. Stacks on narrow screens.
6. **Plain Bootstrap 5.3.** Stock components and Bootstrap Icons. Customisation is limited to the Sass variables in `src/styles/_variables.scss`. No UI framework, no CSS-in-JS, no custom component library. Small utility CSS for things Bootstrap lacks is fine.
7. **No third-party origin at runtime.** Everything is bundled and self-hosted. The only network destinations are the static host and `https://openrouter.ai`.
8. **Heavy libraries are lazy.** pdf.js, ffmpeg.wasm, docx/xlsx writers, the chart library and the markdown renderer load with dynamic `import()` only when used. Budgets: shell ≤ 150 KB gzipped JS, each tool ≤ 80 KB more.

## Conventions

- TypeScript strict; ES modules; no `any` without a comment explaining why.
- Build DOM with the `h()` helper in `src/ui/dom.ts` (its header lists the rules: prop order, handlers, URL props limited to http(s)/mailto/tel/blob/relative, refused tags and props). Never put model output, file names or any other untrusted string into `innerHTML`. Markdown from models goes through `renderMarkdown()` (marked + DOMPurify), which also turns remote images into links so rendering never contacts another host.
- No inline scripts or inline event-handler attributes (CSP is `script-src 'self'`). No inline `style=""` attributes in HTML strings; set styles through CSSOM or classes.
- Internal links and asset URLs go through `url()` in `src/core/paths.ts`, because the site is served from `/or-toolbox/` on GitHub Pages.
- API keys are never logged, never placed in URLs, never written to history, and are masked in the UI (`sk-or-…a1b2`).
- Accessibility is part of done: labelled controls, keyboard reachable, visible focus, `aria-live` for streaming/status, contrast checked in light and dark.
- Motion is 150–250 ms, transform/opacity only, and off under `prefers-reduced-motion` or the Reduced motion setting.
- Unit tests live next to the code as `*.test.ts` (Vitest, jsdom; tests needing IndexedDB `import 'fake-indexeddb/auto'`). E2E specs live in `tests/e2e/`, import `test`/`expect` from `tests/mock/index.ts` (never from `@playwright/test` directly) and only talk to the mocked OpenRouter; no test may reach the real API. Use `watchForProblems()` from `tests/e2e/support.ts` to assert a page has no console errors, failed requests or CSP violations.
- ESLint enforces two of these rules (proved by `tests/lint/`): no HTML-string sinks (`innerHTML`/`outerHTML` in any spelling, `insertAdjacentHTML`, `setHTMLUnsafe`, `parseHTMLUnsafe`, `createContextualFragment`, `document.write`), and no `localStorage`/`sessionStorage`/`indexedDB` outside `src/core` (also via `window.`/`self.`/`top.`/`parent.`).
- Dependencies: assume your knowledge of every library is outdated. Check the installed version's docs or types before using an API. Do not add a dependency if one already in `package.json` does the job.
- Changelog: `CHANGELOG.md` in Keep a Changelog format, short entries, with the commit hash when known.

## Non-obvious decisions

- **Service worker = offline shell + cross-origin isolation.** GitHub Pages cannot send headers, so the one service worker (`src/sw/sw.ts`) adds COOP `same-origin`, COEP `require-corp` and CORP `same-origin` to every same-origin response it serves (needed for multi-threaded ffmpeg.wasm). Always `require-corp`: nothing is hot-linked, so `credentialless` would buy nothing and needs per-browser negotiation. It never calls `respondWith` for cross-origin requests: OpenRouter calls go straight from the page.
  - **Isolation reload is opt-in:** `boot({ isolation: 'required' })` (Diagnostics and Video studio only) reloads once at page start on a first visit, guarded by sessionStorage `ortoolbox:isolation-reload` so it can never loop. Every other page only registers the worker and must never reload (the OAuth callback carries a single-use code); the next page the user opens is isolated anyway. Without isolation, ffmpeg runs single-threaded.
  - **Caches** (all named `ortoolbox-…`, because every project site on `ethanpil.github.io` shares one CacheStorage): `pages-<build hash>` holds the HTML and un-hashed public files, each verified against a SHA-256 recorded at build time (a stale CDN copy fails the install, which the browser retries later; a failed install deletes only its own incomplete cache). `assets` is shared by all builds: every page's eager closure (from Vite's build manifest) is added at install, lazy chunks and `vendor/` files on first request; entries unused for 60 days are pruned. So a tab opened before a deploy can still lazy-load chunks it fetched before. Range requests bypass the cache; every cache call in the fetch path falls back to the network.
  - **Updates:** a new worker `skipWaiting()`s and claims open pages without reloading them; the next page load gets the new shell. Activation deletes only complete pages caches of *older* installs.
- **Shared origin.** For the same reason, localStorage, IndexedDB and sessionStorage are readable by any other page under `https://ethanpil.github.io/`. Keys at rest there are only as safe as every other project site on that origin; a custom domain removes the risk.
- **ffmpeg loading (`src/core/media/ffmpeg.ts`).** `@ffmpeg/ffmpeg` always starts a *module* worker, so we ship the cores' ESM builds, self-hosted under `vendor/ffmpeg/core[-mt]-<version>/` (copied from node_modules by `vite-plugins/ffmpeg-assets.ts`, served by middleware in dev; versioned URLs are immutable). The page downloads the wasm itself (progress against the size recorded at build time, because Content-Length is the gzipped size on Pages) and hands it over as a `blob:` URL; core JS and workers load from same-origin URLs, so no `blob:` worker or script is needed. `optimizeDeps.exclude: ['@ffmpeg/ffmpeg']` is required for its worker URL to survive the dev server. Core start-up has a 60 s timeout; if the multi-threaded core fails or times out, the page uses the single-threaded one for the rest of the session. Terminated or crashed instances are never handed out again; `disposeFfmpeg()` frees everything.
- **CSP** (`vite-plugins/csp.ts`, the single source, with a reason per directive): `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://openrouter.ai blob: data:; img-src 'self' blob: data:; media-src 'self' blob: data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'self'`. Tighter than PLAN.md: no `blob:` workers, no frames, no remote images or media (results arrive as base64 or are fetched from openrouter.ai into Blobs), no form posts to OpenRouter (sign-in is a navigation). `'wasm-unsafe-eval'` is measured as *not* needed by ffmpeg in Chromium/WebKit (wasm compiles inside network-loaded workers, which do not inherit a meta CSP) but is kept for Firefox (unverified) and main-thread wasm (pdf.js fallbacks); it allows wasm compilation, not JS eval. No `'unsafe-inline'` for styles: Bootstrap/Popper set styles through the CSSOM, which CSP does not restrict. `build.assetsInlineLimit: 0` stops Vite inlining fonts as `data:` URLs (would violate `font-src`).
- **Dev parity:** the dev server gets a CSP meta tag from the same table plus only what HMR needs (`'unsafe-inline'` styles, the HMR `ws:` origin), and sends COOP/COEP/CORP via `server.headers` (and from the ffmpeg middleware), so dev pages are isolated without the worker and CSP violations show up in `e2e:dev`. `vite preview` sends no headers, like Pages. Specs that differ between the two read `isDevServer()`.
- **Theme before first paint:** `public/theme-init.js`, a classic render-blocking script (inline scripts are forbidden), reads `appearance.theme` (`light`/`dark`/`system`) from localStorage `ortoolbox:settings` and sets `data-bs-theme`, then follows OS changes while the theme is `system`. It is the one sanctioned storage read outside `src/core`; keep its contract in sync with the settings schema. The View Transitions opt-in is CSS (`@view-transition` in main.scss), not a meta tag.
- **Sass:** Bootstrap and Bootstrap Icons are loaded with `@use … with (…)`, not `@import`, so our own code has no deprecation warnings; `quietDeps` hides the ones inside Bootstrap (import, global-builtin, color-functions, if-function). The icon font URL is overridden in main.scss because the package builds it from variables, which Vite cannot resolve.
- **TypeScript 6, one compiler.** `typescript` is pinned to 6.x for tsc, ESLint, Vite and Vitest alike, because typescript-eslint does not support TS 7 yet (TS 7 ships no JS compiler API). Revisit when it does.
- **Remote media is fetched, not hot-linked.** Under COEP `require-corp` cross-origin `<img>`/`<video>` without CORP are blocked, and the CSP forbids them anyway. Load results with `fetch` → Blob → object URL. `connect-src` allows only openrouter.ai: if a result ever lives on another host (`unsigned_urls` may), use the openrouter.ai content endpoint or grow the CSP deliberately.
- **OpenRouter CORS** (checked 2026-10-02): `Access-Control-Expose-Headers` is only `X-Generation-Id,X-Provider-Name,request-id,cf-ray`, so browser code cannot read `Retry-After`; back off without it. The mock reproduces these headers.
- **Core services are factories** (`createApiClient(core)`, `createKeysService(core)`, …) that read other services from `core` at call time, never in the factory body, so the composition root can wire circular dependencies. Tests pass a partial core (`src/core/api/test-fakes.ts`).
- **API client rules** (`src/core/api/client.ts`): keyless catalog GETs send no custom header (no preflight). Retries wait `error.metadata.retry_after_seconds` when present; a stream is never retried once its response started. `:free` requests are throttled to 20 per rolling minute through localStorage `ortoolbox:free-requests` (shared across tabs, approximate). A `noRetention` key adds `provider.data_collection:"deny"` except on free models (it turns them into a 404) and never on `/images` or `/videos` (not in their schema). TTS bytes carry no cost, so usage is estimated from the most expensive endpoint (`costEstimated`); video cost arrives only on the completed status read (`VideoJobStatus.costUsd`), which the tool adds to its run.
- **Key lock:** every lock change rewrites `ortoolbox:keys` with one `setItem` and is refused (`KeysChangedError`) if another tab wrote meanwhile. sessionStorage `ortoolbox:unlocked` holds `{key, at}` (raw AES key, last `touch()`), so auto-lock survives navigation between pages of one tab. The effective default key is `settings.defaultKeyId`, else the first key (a settings reset must not strand a user with keys).
- **Models:** capabilities and free detection follow docs/openrouter-api.md §9 (free = id only; music = Lyria). `ModelPricing.prompt/completion` are null for non-token units (TTS, STT, video, music); estimates read `pricing.raw` with deliberately high heuristics (`src/core/models/estimate.ts`). Shipped defaults and their reasons live in `src/core/models/defaults.ts`; re-check them when the catalog moves.
- **Media gotchas:** never use fflate's async API (`zip`, `unzip`, `deflate`): it spawns `blob:` workers that `worker-src 'self'` blocks, and fflate then never settles. Use `zipSync` or `zipFiles()` from `src/core/export`. Multi-threaded ffmpeg crashes on H.264 encodes with the default thread count; every `exec` must pass explicit `-threads` limits (see `src/core/media/ffmpeg-ops.ts`). Import `src/core/media/pdf.ts` dynamically only (about 5 MB of pdf.js assets).
- **E2E runs with service workers blocked by default**; only the `sw-*` Playwright projects allow them and run `tests/e2e/sw/` only. The app must work fully without the worker.
  - In WebKit, requests from a page controlled by a service worker bypass Playwright's `context.route`, so they would reach the real network. Specs in `tests/e2e/sw/` must not call OpenRouter. As a backstop, every project sends non-localhost traffic to a dead proxy.
  - Playwright's `setOffline()` in WebKit also fails requests the worker would answer from cache; offline specs use `startPrivatePreview()` (a private `vite preview` they shut down) instead.
  - Playwright's Firefox build does not start on some Windows 10 machines ("side-by-side configuration is incorrect", `mozglue`). There, run with `E2E_SKIP_BROWSERS=firefox`; CI runs Firefox and WebKit in its e2e matrix.
  - The mock enforces OpenRouter's real CORS allow-headers list on the actual request (Chromium and Firefox answer preflights inside Playwright) and serves binary bodies; `mock.file()` serves `tests/fixtures/media/`.
  - The mock serves SSE bodies in one piece (`route.fulfill` cannot stream), so event parsing is tested but pacing is not.
- **Fixtures named `*.documented.json` were written from the docs, not recorded**, because development had no API key. Replace them with recordings when a key is available.
- **Core state services** (`src/core/{bus,settings,runs,budgets,stats,history,prompts,jobs,results,tool-state,backup,data}`). Each is `createXService(core)` and reads other services from `core` only at call time, so the composition root can fill one object in any order. `src/core/testing/state-fakes.ts` wires them the same way for tests.
  - **Budgets read the local ledger** (`stats` rows, written when a run finishes), never OpenRouter's lagging `/key` usage. In-flight runs are not counted, so parallel runs are each checked without the others' estimates. "Delete all prompts and history" clears stats too (contract), which resets this month's spend.
  - **pagehide aborts active runs** and records them `aborted`, except runs that an open job references (video): those stay `running` for `runs.reattach()` after a reload. A tool whose run continues in a job must not `fail()` it on that abort.
  - **Jobs** poll under the Web Lock `ortoolbox:job:<id>` (`ifAvailable`); other tabs retry at the poll interval and take over when the holder closes. Poll results are written read-modify-write and dropped once the job is final, so a cancel from another tab wins. `attempts` counts failed polls.
  - **Backups** wrap the exact `ortoolbox:keys` JSON in a passphrase envelope. Replace wipes keys only when the backup carries keys; merge skips keys when the two sides use different passphrase locks; `defaultKeyId` follows the backup only when its keys are taken. No passphrase: everything but keys is imported. Wrong passphrase: nothing is.
  - **Settings** `reset()` keeps `defaultKeyId` (keys are not affected). An older tab drops fields of a newer schema version on its next write.
