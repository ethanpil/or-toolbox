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

### Changed

- Stage 0 review fixes: COEP `require-corp` only, isolation reload limited to pages that need threads, manifest-based offline shell with pruned shared asset cache, hardened `h()` and Markdown sanitising, dev-server CSP and isolation, TypeScript 6, single gated CI pipeline.
