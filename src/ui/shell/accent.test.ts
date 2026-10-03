import { describe, expect, it } from 'vitest';
import {
  ACCENT_PROPERTIES,
  accentProperties,
  contrast,
  contrastText,
  parseHex,
  readableOn,
  shade,
  tint,
  toHex,
} from './accent';

const WHITE = [255, 255, 255] as const;
const DARK_BODY = [33, 37, 41] as const;

describe('colour helpers', () => {
  it('parses and prints hex colours', () => {
    expect(parseHex('#4f46e5')).toEqual([79, 70, 229]);
    expect(parseHex('4F46E5')).toEqual([79, 70, 229]);
    expect(parseHex('#fff')).toBeNull();
    expect(parseHex('red')).toBeNull();
    expect(toHex([79, 70, 229])).toBe('#4f46e5');
  });

  it('matches Bootstrap’s tint and shade for the shipped primary', () => {
    const primary = parseHex('#4f46e5')!;
    // Values Bootstrap compiled into the stylesheet (btn hover, dark-mode link and subtle colours).
    expect(toHex(shade(primary, 0.15))).toBe('#433cc3');
    expect(toHex(tint(primary, 0.4))).toBe('#9590ef');
    expect(toHex(shade(primary, 0.8))).toBe('#100e2e');
    expect(toHex(shade(primary, 0.4))).toBe('#2f2a89');
  });

  it('computes WCAG contrast', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
  });

  it('picks white text on dark colours and black text on light ones', () => {
    expect(contrastText(parseHex('#4f46e5')!)).toEqual([255, 255, 255]);
    expect(contrastText(parseHex('#facc15')!)).toEqual([0, 0, 0]);
  });

  it('moves a colour until it is readable', () => {
    const yellow = parseHex('#facc15')!;
    expect(contrast(readableOn(yellow, [...WHITE]), [...WHITE])).toBeGreaterThanOrEqual(4.5);
    const navy = parseHex('#1e1b4b')!;
    expect(contrast(readableOn(navy, [...DARK_BODY]), [...DARK_BODY])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('accentProperties', () => {
  it('rejects invalid colours', () => {
    expect(accentProperties('nope', 'light')).toBeNull();
  });

  it('lists every property it can set', () => {
    expect(Object.keys(accentProperties('#0f766e', 'dark')!)).toEqual([...ACCENT_PROPERTIES]);
  });

  it.each(['#facc15', '#22d3ee', '#4f46e5', '#0f766e', '#1e1b4b', '#ec4899', '#ffffff', '#000000'])(
    'keeps links and button text readable for %s in both themes',
    (hex) => {
      for (const theme of ['light', 'dark'] as const) {
        const props = accentProperties(hex, theme)!;
        const background = theme === 'light' ? [...WHITE] : [...DARK_BODY];
        const link = parseHex(props['--bs-link-color']!)!;
        expect(contrast(link, background as [number, number, number])).toBeGreaterThanOrEqual(4.5);
        const accent = parseHex(props['--bs-primary']!)!;
        const onAccent = parseHex(props['--or-accent-contrast']!)!;
        // Pure mid-tones cannot reach 4.5 with either black or white; the better of the two is chosen.
        expect(contrast(onAccent, accent)).toBeGreaterThanOrEqual(
          Math.min(4.5, Math.max(contrast([...WHITE], accent), contrast([0, 0, 0], accent))),
        );
      }
    },
  );

  it('exposes the accent as an RGB list for Bootstrap’s rgba() utilities', () => {
    expect(accentProperties('#4f46e5', 'light')!['--bs-primary-rgb']).toBe('79, 70, 229');
  });
});
