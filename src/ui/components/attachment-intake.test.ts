import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AttachmentRef,
  MAX_ATTACHMENTS,
  SIZE_LIMITS,
} from '../../core/attachments/attachments';
import { InvalidInputError } from '../../core/errors';
import { attachmentIntake } from './attachment-intake';

afterEach(() => {
  document.body.replaceChildren();
});

function setup(noun = 'message', existing: AttachmentRef[] = []) {
  let files: AttachmentRef[] = existing;
  const kept = new Map<string, string>();
  const field = { value: '' };
  const changed = vi.fn();
  const intake = attachmentIntake({
    noun,
    files: () => files,
    setFiles: (next) => {
      files = next;
    },
    keep: (id, data) => kept.set(id, data),
    field,
    changed,
  });
  return { intake, field, changed, kept, files: () => files };
}

const textFile = (name: string, content = 'hello') =>
  new File([content], name, { type: 'text/plain' });
const warning = (): string | null =>
  document.querySelector('[data-testid="attach-error"]')?.textContent ?? null;

describe('attachmentIntake', () => {
  it('attaches files, keeps the bytes of the ones that have some, and redraws once', async () => {
    const { intake, files, kept, changed } = setup();
    await intake.addFiles([
      textFile('notes.txt'),
      new File([new Uint8Array([1, 2, 3])], 'red.png', { type: 'image/png' }),
    ]);
    expect(files().map((ref) => ref.name)).toEqual(['notes.txt', 'red.png']);
    expect(files()[0]).toMatchObject({ kind: 'text', text: 'hello' });
    expect(kept.get(files()[1]!.id)).toBe('data:image/png;base64,AQID');
    expect(kept.size).toBe(1);
    expect(changed).toHaveBeenCalledOnce();
    expect(warning()).toBeNull();
  });

  it('collects what it could not attach into one warning and keeps the rest', async () => {
    const { intake, files } = setup();
    const huge = textFile('huge.txt', 'x'.repeat(SIZE_LIMITS.text + 1));
    await intake.addFiles([huge, textFile('ok.txt'), huge]);
    expect(files().map((ref) => ref.name)).toEqual(['ok.txt']);
    expect(warning()).toContain('huge.txt');
  });

  it('names what the files go with when there are too many', async () => {
    const full = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({
      id: `id${i}`,
      name: `f${i}.txt`,
      type: 'text/plain',
      size: 1,
      kind: 'text' as const,
      text: 'x',
    }));
    const message = setup('message', full);
    await message.intake.addFiles([textFile('one-more.txt')]);
    expect(warning()).toContain(`At most ${MAX_ATTACHMENTS} files go with one message.`);
    document.body.replaceChildren();

    const prompt = setup('prompt', full);
    await prompt.intake.addFiles([textFile('one-more.txt')]);
    expect(warning()).toContain(`At most ${MAX_ATTACHMENTS} files go with one prompt.`);
    expect(() => prompt.intake.attach(full[0]!)).toThrow(InvalidInputError);
  });

  it('says "prompt" or "message" in the text limit too', () => {
    const one = (noun: string): void => {
      const { intake } = setup(noun, [
        { id: 'a', name: 'a.txt', type: 'text/plain', size: 1_900_000, kind: 'text', text: 'x' },
      ]);
      intake.attach({
        id: 'b',
        name: 'b.txt',
        type: 'text/plain',
        size: 400_000,
        kind: 'text',
        text: 'y',
      });
    };
    expect(() => one('prompt')).toThrow(/one prompt takes at most/);
    expect(() => one('message')).toThrow(/one message takes at most/);
  });

  describe('receive ("Send to…")', () => {
    it('puts unnamed text in the field, named text and files among the attachments', async () => {
      const { intake, field, files, changed } = setup();
      field.value = 'Look at this:';
      intake.receive([
        { kind: 'text', text: 'pasted words' },
        { kind: 'text', text: '# Notes', name: 'notes.md', type: 'text/markdown' },
        { kind: 'file', blob: new Blob(['abc'], { type: 'text/plain' }), name: 'sent.txt' },
      ]);
      expect(field.value).toBe('Look at this:\n\npasted words');
      expect(files().map((ref) => ref.name)).toEqual(['notes.md']);
      expect(changed).toHaveBeenCalledOnce(); // the text is drawn at once…
      await vi.waitFor(() =>
        expect(files().map((ref) => ref.name)).toEqual(['notes.md', 'sent.txt']),
      );
      expect(changed).toHaveBeenCalledTimes(2); // …and the files when they are read
    });

    it('refuses typed text over the limit, naming what it was sent to', () => {
      const big = 'x'.repeat(SIZE_LIMITS.text + 1);
      const message = setup('message');
      message.intake.receive([{ kind: 'text', text: big }]);
      expect(message.field.value).toBe('');
      expect(warning()).toContain('A message takes at most');
      document.body.replaceChildren();

      const prompt = setup('prompt');
      prompt.intake.receive([{ kind: 'text', text: big }]);
      expect(warning()).toContain('A prompt takes at most');
    });
  });
});
