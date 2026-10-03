/**
 * Accent colour maths (Settings → Appearance → Accent). Pure functions, so they are unit-tested without a page.
 *
 * Bootstrap derives every shade of the primary colour at Sass compile time. A user-chosen accent is applied at
 * run time instead: `accentProperties()` returns the same family of values Bootstrap would compute (tints and
 * shades with Bootstrap's own weights), plus a text colour that keeps WCAG AA contrast whatever colour was
 * picked. appearance.ts writes them on <html> through the CSSOM; src/styles/_accent.scss points the components
 * that hard-code the primary colour at these properties while `data-accent` is set.
 */

export type Rgb = [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
/** Bootstrap's dark-mode body background, which dark-mode links must contrast with. */
const DARK_BODY: Rgb = [33, 37, 41];
/** WCAG AA for normal text. */
const AA = 4.5;

export function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Sass `mix($a, $b, $weight)`: `weight` of `a`, the rest of `b`. */
export function mix(a: Rgb, b: Rgb, weight: number): Rgb {
  return [0, 1, 2].map((i) => a[i]! * weight + b[i]! * (1 - weight)) as Rgb;
}

/** Bootstrap's `tint-color()` (towards white) and `shade-color()` (towards black). */
export const tint = (colour: Rgb, weight: number): Rgb => mix(WHITE, colour, weight);
export const shade = (colour: Rgb, weight: number): Rgb => mix(BLACK, colour, weight);

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** White unless it falls short of AA on `background` and black does better (Bootstrap's `color-contrast()`). */
export function contrastText(background: Rgb): Rgb {
  if (contrast(WHITE, background) >= AA) return WHITE;
  return contrast(BLACK, background) > contrast(WHITE, background) ? BLACK : WHITE;
}

/** Moves `colour` towards white or black in small steps until it reaches AA on `background`. */
export function readableOn(colour: Rgb, background: Rgb): Rgb {
  const towards = luminance(background) > 0.5 ? shade : tint;
  let result = colour;
  for (let step = 1; step <= 20 && contrast(result, background) < AA; step++) {
    result = towards(colour, step * 0.05);
  }
  return result;
}

const rgbList = ([r, g, b]: Rgb): string => `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;

/**
 * The custom properties for one accent colour in one theme. Keys are CSS custom property names. `--bs-*` are
 * Bootstrap's own (overridden on <html>); `--or-accent-*` feed the component rules in _accent.scss.
 */
export function accentProperties(
  hex: string,
  theme: 'light' | 'dark',
): Record<string, string> | null {
  const accent = parseHex(hex);
  if (!accent) return null;
  const onAccent = contrastText(accent);
  const darkText = onAccent === BLACK;
  // Bootstrap: buttons with dark text lighten on hover, buttons with white text darken.
  const hover = darkText ? tint(accent, 0.15) : shade(accent, 0.15);
  const active = darkText ? tint(accent, 0.2) : shade(accent, 0.2);

  const light = theme === 'light';
  const textEmphasis = light ? shade(accent, 0.6) : tint(accent, 0.4);
  const bgSubtle = light ? tint(accent, 0.8) : shade(accent, 0.8);
  const borderSubtle = light ? tint(accent, 0.6) : shade(accent, 0.4);
  const link = readableOn(light ? accent : tint(accent, 0.4), light ? WHITE : DARK_BODY);
  const linkHover = light ? shade(link, 0.2) : tint(link, 0.2);

  return {
    '--bs-primary': toHex(accent),
    '--bs-primary-rgb': rgbList(accent),
    '--bs-primary-text-emphasis': toHex(readableOn(textEmphasis, light ? bgSubtle : DARK_BODY)),
    '--bs-primary-bg-subtle': toHex(bgSubtle),
    '--bs-primary-border-subtle': toHex(borderSubtle),
    '--bs-link-color': toHex(link),
    '--bs-link-color-rgb': rgbList(link),
    '--bs-link-hover-color': toHex(linkHover),
    '--bs-link-hover-color-rgb': rgbList(linkHover),
    '--bs-focus-ring-color': `rgba(${rgbList(accent)}, 0.25)`,
    '--or-accent-contrast': toHex(onAccent),
    '--or-accent-hover': toHex(hover),
    '--or-accent-active': toHex(active),
    '--or-accent-text': toHex(link),
  };
}

/** Every property `accentProperties()` may set, so they can all be removed again. */
export const ACCENT_PROPERTIES: readonly string[] = Object.keys(
  accentProperties('#4f46e5', 'light') ?? {},
);
