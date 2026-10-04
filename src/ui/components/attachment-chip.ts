/**
 * `attachmentChip()`: one attached file as a small chip (a thumbnail for images, else the kind's icon; the name;
 * its size or a note), optionally with a Remove button. Chat's composer and messages and Model arena's prompt use
 * it, inside a `<ul class="list-unstyled d-flex flex-wrap gap-2">`.
 *
 * ```ts
 * attachmentChip({ ref, data, remove: { onClick: () => drop(ref.id), focusKey: `unattach:${ref.id}` } });
 * ```
 */
import type { AttachmentKind, AttachmentRef } from '../../core/attachments/attachments';
import { h } from '../dom';
import { formatBytes } from '../format';
import { icon } from '../icon';

export const ATTACHMENT_ICONS: Readonly<Record<AttachmentKind, string>> = {
  image: 'file-earmark-image',
  pdf: 'file-earmark-pdf',
  audio: 'file-earmark-music',
  text: 'file-earmark-text',
};

export interface AttachmentChipOptions {
  ref: AttachmentRef;
  /** The image's data URL, for a thumbnail. */
  data?: string;
  /** The bytes are gone: a dashed chip with `note` in place of the size. */
  missing?: { note: string; testId?: string };
  testId?: string;
  remove?: { onClick: () => void; focusKey: string; testId?: string };
}

export function attachmentChip(options: AttachmentChipOptions): HTMLLIElement {
  const { ref, data, missing, remove } = options;
  return h(
    'li',
    {
      class: ['or-attachment', missing && 'is-missing'],
      'data-testid': options.testId ?? null,
    },
    ref.kind === 'image' && data
      ? h('img', { class: 'or-attachment-thumb', src: data, alt: '' })
      : icon(ATTACHMENT_ICONS[ref.kind]),
    h(
      'span',
      { class: 'min-w-0' },
      h('span', { class: 'd-block text-truncate' }, ref.name),
      h(
        'span',
        {
          class: ['d-block small', missing ? 'text-warning-emphasis' : 'text-body-secondary'],
          'data-testid': missing?.testId ?? null,
        },
        missing ? missing.note : formatBytes(ref.size),
      ),
    ),
    remove &&
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-link or-attachment-remove',
          'aria-label': `Remove ${ref.name}`,
          title: `Remove ${ref.name}`,
          'data-focus-key': remove.focusKey,
          'data-testid': remove.testId ?? null,
          onclick: remove.onClick,
        },
        icon('x-lg'),
      ),
  );
}
