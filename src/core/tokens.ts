/**
 * A token count approximation for text, deliberately on the high side: 4 Latin characters per token, 2 for other
 * alphabets, 1 per CJK, Hangul, kana, Indic or Thai character. It decides context trimming, `max_tokens` clamps
 * and cost estimates, never billing (the API's `usage` does). Chat keeps its own copy in src/tools/chat/request.ts
 * (same rules); new code imports this one.
 */

/** Scripts where one character is about one token (or more): CJK, kana, Hangul, Indic, Thai and neighbours. */
function isWide(code: number): boolean {
  return (
    (code >= 0x0900 && code <= 0x0dff) || // Devanagari … Sinhala
    (code >= 0x0e00 && code <= 0x0eff) || // Thai, Lao
    (code >= 0x1000 && code <= 0x109f) || // Myanmar
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x1780 && code <= 0x17ff) || // Khmer
    (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals, kana, CJK ideographs
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7ff) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
    (code >= 0xff00 && code <= 0xffef) // full-width forms
  );
}

export function approxTokens(text: string): number {
  let latin = 0;
  let other = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x0250) latin++;
    else if (isWide(code)) wide++;
    else other++; // other alphabets; each half of a surrogate pair (emoji, rare CJK) counts here
  }
  return Math.ceil(latin / 4 + other / 2 + wide);
}
