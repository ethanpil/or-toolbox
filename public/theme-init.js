/*
 * Sets the colour theme before the first paint, so a dark-mode user never
 * sees a white flash, and keeps following the operating system while the
 * theme is "system". Loaded by every page as a classic, render-blocking
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

  function savedTheme() {
    try {
      var settings = JSON.parse(localStorage.getItem('ortoolbox:settings') || 'null');
      var theme = settings && settings.appearance && settings.appearance.theme;
      return theme === 'light' || theme === 'dark' ? theme : 'system';
    } catch {
      return 'system'; // storage blocked or the value is corrupt
    }
  }

  var darkQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

  function apply() {
    var theme = savedTheme();
    if (theme === 'system') theme = darkQuery && darkQuery.matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-bs-theme', theme);
  }

  apply();
  // Re-read the setting on every change, so an explicit choice made later wins.
  if (darkQuery && typeof darkQuery.addEventListener === 'function') {
    darkQuery.addEventListener('change', apply);
  }
})();
