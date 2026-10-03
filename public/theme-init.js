/*
 * Sets the colour theme (and the density and reduced-motion switches) before the first paint, so a dark-mode
 * user never sees a white flash and a compact layout never jumps, and keeps following the operating system while
 * the theme is "system". Loaded by every page as a classic, render-blocking <script> in <head> (injected by
 * vite-plugins/html-head.ts); it is an external file because the CSP forbids inline scripts. Once the page's
 * module loads, src/ui/shell/appearance.ts keeps all of this (and the accent colour) in step with the settings.
 *
 * Contract with src/core/settings: the JSON under localStorage key `ortoolbox:settings` holds
 * `appearance.theme` ("light", "dark" or "system"; anything else means "system"), `appearance.density`
 * ("compact" sets data-density) and `appearance.reducedMotion` (true sets data-reduced-motion).
 *
 * Keep this file tiny and dependency-free. It is served as-is, not bundled.
 */
(function () {
  'use strict';

  function appearance() {
    try {
      var settings = JSON.parse(localStorage.getItem('ortoolbox:settings') || 'null');
      return (settings && settings.appearance) || {};
    } catch {
      return {}; // storage blocked or the value is corrupt
    }
  }

  var darkQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
  var root = document.documentElement;

  function apply() {
    var saved = appearance();
    var theme = saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : 'system';
    if (theme === 'system') theme = darkQuery && darkQuery.matches ? 'dark' : 'light';
    root.setAttribute('data-bs-theme', theme);
    if (saved.density === 'compact') root.setAttribute('data-density', 'compact');
    if (saved.reducedMotion === true) root.setAttribute('data-reduced-motion', '');
  }

  apply();
  // Re-read the setting on every change, so an explicit choice made later wins.
  if (darkQuery && typeof darkQuery.addEventListener === 'function') {
    darkQuery.addEventListener('change', apply);
  }

  // The incoming side of a cross-document view transition. Only a script that runs before the first render can
  // see it: skip it under the Reduced motion setting, and handle the promises a skipped or aborted transition
  // rejects. (The outgoing side is in src/ui/shell/appearance.ts.)
  window.addEventListener('pagereveal', function (event) {
    var transition = event.viewTransition;
    if (!transition) return;
    var ignore = function () {};
    transition.ready.catch(ignore);
    transition.finished.catch(ignore);
    transition.updateCallbackDone.catch(ignore);
    if (appearance().reducedMotion === true) transition.skipTransition();
  });

  // Chromium aborts a cross-document view transition when a page is not ready in time (a busy machine, a slow
  // first load) and rejects a promise of a transition no script was given, so it would surface as an uncaught
  // error. The navigation itself is unaffected; only that exact rejection is silenced.
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    if (
      reason &&
      (reason.name === 'InvalidStateError' || reason.name === 'AbortError') &&
      /^Transition was (aborted|skipped)/.test(String(reason.message))
    ) {
      event.preventDefault();
    }
  });
})();
