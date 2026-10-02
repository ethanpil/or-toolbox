/*
 * Sets the colour theme before the first paint, so a dark-mode user never
 * sees a white flash. Loaded by every page as a classic, render-blocking
 * <script> in <head> (injected by vite-plugins/html-head.ts); it is an
 * external file because the CSP forbids inline scripts.
 *
 * Contract with src/core/settings (Stage 1): the saved theme is at
 * `appearance.theme` in the JSON under localStorage key `ortoolbox:settings`
 * and is "light", "dark" or "system". Anything else means "system".
 *
 * Keep this file tiny and dependency-free. It is served as-is, not bundled.
 */
(function () {
  'use strict';

  var theme = 'system';
  try {
    var settings = JSON.parse(localStorage.getItem('ortoolbox:settings') || 'null');
    var saved = settings && settings.appearance && settings.appearance.theme;
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch {
    // Storage is blocked or the value is corrupt: follow the system.
  }

  if (theme === 'system') {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-bs-theme', theme);
})();
