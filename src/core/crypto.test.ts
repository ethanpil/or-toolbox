import { describe, expect, it } from 'vitest';
import { decryptWithPassphrase, encryptWithPassphrase } from './crypto';

describe('passphrases', () => {
  it('derive the same key however the keyboard composed the characters (NFC)', async () => {
    const composed = 'café au lait'; // é as one code point
    const decomposed = 'café au lait'; // e + combining acute
    const envelope = await encryptWithPassphrase(composed, 'secret', 1000);
    await expect(decryptWithPassphrase(decomposed, envelope)).resolves.toBe('secret');
    await expect(decryptWithPassphrase('cafe au lait', envelope)).rejects.toThrow();
  });
});
