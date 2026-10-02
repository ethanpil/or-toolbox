# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Stage 0 foundations:
  - Vite 8 multi-page build (22 pages, base `/or-toolbox/`, overridable with `BASE_PATH`), strict TypeScript 7, ESLint + Prettier, Vitest (jsdom), Playwright (Chromium, Firefox, WebKit).
  - Shared `<head>` injection with a build-time CSP meta tag, theme set before first paint, PWA manifest and icons generated from an original SVG logo.
  - Tool manifests and placeholder pages for all 14 tools, plus a typed tool registry.
  - Core helpers: `url()`, the `h()` DOM builder, sanitised `renderMarkdown()`.
  - Service worker providing cross-origin isolation (COOP/COEP/CORP) and an offline shell.
  - Self-hosted ffmpeg.wasm loader: multi-threaded core when isolated, single-threaded otherwise.
  - Diagnostics page with an ffmpeg smoke test.
  - Mocked OpenRouter for e2e tests, Stage 0 gate tests, and GitHub Actions for CI and Pages deployment.
