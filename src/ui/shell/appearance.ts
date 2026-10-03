/**
 * Settings → Appearance, applied live on every page and kept in step with other tabs (the settings service
 * reports their changes):
 *
 * - theme: `data-bs-theme` on <html> (public/theme-init.js sets it before first paint; this keeps it current,
 *   including while "system" follows the OS);
 * - accent: Bootstrap's primary-colour custom properties overridden on <html> through the CSSOM, plus
 *   `data-accent` so src/styles/_accent.scss re-points the components that hard-code the primary colour;
 * - density: `data-density="compact"`;
 * - reduced motion: `data-reduced-motion`, which switches off transitions and animations
 *   (src/styles/_motion.scss) and skips cross-document view transitions.
 */
import type { Settings, SettingsService, ThemeMode } from '../../core/types';
import { ACCENT_PROPERTIES, accentProperties } from './accent';

const darkQuery =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
const motionQuery =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return darkQuery?.matches ? 'dark' : 'light';
  return mode;
}

/** True when motion should be off: the OS asks for it or the Reduced motion setting is on. */
export function motionReduced(settings: Readonly<Settings>): boolean {
  return settings.appearance.reducedMotion || motionQuery?.matches === true;
}

/** The theme and accent last applied, to notice real changes. */
let applied: string | null = null;

/**
 * Colours switch instantly: without this, every button would animate its colour for 150 ms after a theme or
 * accent change (and an accessibility scan could catch the halfway colours).
 */
function pauseTransitions(root: HTMLElement): void {
  root.setAttribute('data-no-transition', '');
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.removeAttribute('data-no-transition')),
  );
}

export function applyAppearance(
  settings: Readonly<Settings>,
  root: HTMLElement = document.documentElement,
): void {
  const { theme, accent, density, reducedMotion } = settings.appearance;
  const resolved = resolveTheme(theme);
  const key = `${resolved}|${accent ?? ''}`;
  if (applied !== null && applied !== key) pauseTransitions(root);
  applied = key;
  root.setAttribute('data-bs-theme', resolved);

  const properties = accent ? accentProperties(accent, resolved) : null;
  for (const name of ACCENT_PROPERTIES) {
    const value = properties?.[name];
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  root.toggleAttribute('data-accent', properties !== null);

  if (density === 'compact') root.setAttribute('data-density', 'compact');
  else root.removeAttribute('data-density');
  root.toggleAttribute('data-reduced-motion', reducedMotion);
}

/** Applies the current appearance and follows changes (this tab, other tabs, the OS colour scheme). */
export function installAppearance(settings: SettingsService): void {
  applyAppearance(settings.get());
  settings.subscribe((next) => applyAppearance(next));
  darkQuery?.addEventListener('change', () => applyAppearance(settings.get()));

  // Cross-document view transitions, outgoing side: skip when motion is reduced (the CSS opt-in cannot depend
  // on a setting). A transition the browser aborts or skips rejects its promises; that is expected, so they are
  // handled here rather than reported as errors.
  const quiet = (transition: ViewTransition | null): void => {
    transition?.ready.catch(() => undefined);
    transition?.updateCallbackDone.catch(() => undefined);
    transition?.finished.catch(() => undefined);
  };
  window.addEventListener('pageswap', (event) => {
    quiet(event.viewTransition);
    if (motionReduced(settings.get())) event.viewTransition?.skipTransition();
  });
  // The incoming side (pagereveal) fires before this module runs; public/theme-init.js handles it.
}
