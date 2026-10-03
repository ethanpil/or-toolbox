/**
 * Text that goes into XML parts of Office files (docx, xlsx). Word and Excel
 * refuse a file, and ask to "repair" it, when a text node holds a character
 * XML 1.0 cannot carry, and model output and OCR text contain them now and then.
 */

/**
 * Removes what XML 1.0 forbids in text: control characters other than tab,
 * line feed and carriage return, the non-characters (U+FFFE, U+FFFF, …) and
 * lone surrogates. The C1 controls (U+0080–U+009F) are legal but go too, since
 * they are never meant and Office shows them as boxes.
 */
export function stripIllegalXml(text: string): string {
  return text.replace(/[\p{Cc}\p{Cs}\p{Noncharacter_Code_Point}]/gu, (char) =>
    char === '\t' || char === '\n' || char === '\r' ? char : '',
  );
}
