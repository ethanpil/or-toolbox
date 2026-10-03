/** OpenRouter key format checks and masking. Format only: liveness is checked with `GET /key`. */

export const KEY_PREFIX = 'sk-or-';

/** Thrown by `keys.add` when the pasted text is not shaped like an OpenRouter key. */
export class InvalidKeyError extends Error {
  override readonly name = 'InvalidKeyError';
}

/** Trims whitespace, a pasted `Bearer ` prefix and surrounding quotes. */
export function normalizeKeyInput(input: string): string {
  return input
    .trim()
    .replace(/^bearer\s+/i, '')
    .replace(/^["'`](.*)["'`]$/s, '$1')
    .trim();
}

/** Null when the format is plausible, else a short message for the user. */
export function keyFormatProblem(secret: string): string | null {
  if (!secret) return 'Paste an OpenRouter key.';
  if (!secret.startsWith(KEY_PREFIX)) return 'OpenRouter keys start with “sk-or-”.';
  if (/\s/.test(secret)) return 'The key contains spaces or line breaks.';
  if (!/^sk-or-[A-Za-z0-9][A-Za-z0-9_-]{15,199}$/.test(secret))
    return 'That does not look like a complete OpenRouter key.';
  return null;
}

/** `sk-or-…a1b2`: safe to display, log and export. */
export function maskKey(secret: string): string {
  return `${KEY_PREFIX}…${secret.slice(-4)}`;
}
