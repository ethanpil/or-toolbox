import { describe, expect, it, vi } from 'vitest';
import type { AttachmentRef } from '../../core/attachments/attachments';
import { attachmentChip } from './attachment-chip';

const ref = (kind: AttachmentRef['kind']): AttachmentRef => ({
  id: 'a1',
  name: `file.${kind}`,
  type: '',
  size: 2048,
  kind,
});

describe('attachmentChip', () => {
  it('shows a thumbnail for an image with its bytes, else the kind’s icon, and the size', () => {
    const image = attachmentChip({ ref: ref('image'), data: 'data:image/png;base64,AA' });
    expect(image.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA');
    expect(image.textContent).toContain('file.image');
    expect(image.textContent).toContain('2 KB');

    const pdf = attachmentChip({ ref: ref('pdf'), testId: 'chip' });
    expect(pdf.querySelector('img')).toBeNull();
    expect(pdf.querySelector('.bi-file-earmark-pdf')).not.toBeNull();
    expect(pdf.dataset['testid']).toBe('chip');
    expect(pdf.querySelector('button')).toBeNull();
  });

  it('says when the bytes are gone, and removes with a labelled, keyed button', () => {
    const onClick = vi.fn();
    const chip = attachmentChip({
      ref: ref('audio'),
      missing: { note: 'Attachment not kept after reload', testId: 'missing' },
      remove: { onClick, focusKey: 'unattach:a1', testId: 'remove' },
    });
    expect(chip.classList.contains('is-missing')).toBe(true);
    expect(chip.querySelector('[data-testid="missing"]')?.textContent).toBe(
      'Attachment not kept after reload',
    );
    const button = chip.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Remove file.audio');
    expect(button.dataset['focusKey']).toBe('unattach:a1');
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
