/**
 * `dropZone()`: a file target that works with a mouse, a keyboard and a screen reader. Files can be dropped on
 * it or chosen with its "Choose files" button (a real button, so Tab/Enter/Space work); it highlights while
 * files are dragged over it and filters by `accept` (MIME types, `type/*` wildcards; extension fallback).
 *
 * ```ts
 * input.append(dropZone({ accept: manifest.accepts, multiple: true, onFiles: (files) => add(files) }));
 * ```
 *
 * A drop on the zone does not reach the tool page's full-page drop overlay (it stops propagation).
 *
 * The button carries `data-focus-key` (`focusKey`, default `drop-zone`), so a tool that rebuilds the zone with
 * `replace()` (a new label, `multiple` after a file was added) gives focus back to the new button after a file
 * dialog. Two zones rebuilt inside one container need keys of their own.
 */
import { h } from '../dom';
import { toast } from '../feedback/toast';
import { plural } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import { describeAccept, partitionFiles } from './file-types';

export interface DropZoneOptions {
  /** MIME types; empty or absent accepts anything. */
  accept?: readonly string[];
  multiple?: boolean;
  /** Main line, default "Drop files here". */
  label?: string;
  /** Second line, default derived from `accept` ("PNG, JPEG or PDF"). */
  hint?: string;
  onFiles: (files: File[]) => void;
  /** Called with refused files; default: a toast naming what is accepted. */
  onReject?: (files: File[]) => void;
  compact?: boolean;
  /** `data-focus-key` of the Choose button; default `drop-zone`. */
  focusKey?: string;
  testId?: string;
}

export function dropZone(options: DropZoneOptions): HTMLElement {
  const accept = options.accept ?? [];
  const labelId = uid('drop-label');
  const hintId = uid('drop-hint');

  const deliver = (list: FileList | File[] | null): void => {
    const files = [...(list ?? [])];
    if (files.length === 0) return;
    const { accepted, rejected } =
      accept.length > 0 ? partitionFiles(files, accept) : { accepted: files, rejected: [] };
    const taken = options.multiple ? accepted : accepted.slice(0, 1);
    if (taken.length > 0) options.onFiles(taken);
    if (rejected.length > 0) {
      if (options.onReject) options.onReject(rejected);
      else
        toast({
          variant: 'warning',
          message: `Skipped ${plural(rejected.length, 'file')}: this accepts ${describeAccept(accept)}.`,
        });
    }
  };

  const input = h('input', {
    type: 'file',
    hidden: true,
    multiple: options.multiple ?? false,
    accept: accept.join(','),
    tabIndex: -1,
    onchange: () => {
      deliver(input.files);
      input.value = '';
    },
  });

  const button = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-primary',
      'aria-describedby': `${labelId} ${hintId}`,
      'data-focus-key': options.focusKey ?? 'drop-zone',
      'data-testid': 'drop-zone-button',
      onclick: (event: MouseEvent) => {
        event.stopPropagation();
        input.click();
      },
    },
    icon('folder2-open', 'me-1'),
    options.multiple ? 'Choose files' : 'Choose a file',
  );

  const zone = h(
    'div',
    {
      class: ['or-drop-zone', options.compact && 'or-drop-zone-compact'],
      'data-testid': options.testId ?? 'drop-zone',
      // The input's own (programmatic) click bubbles up here too.
      onclick: (event: MouseEvent) => {
        if (event.target !== input) input.click();
      },
    },
    h('div', { class: 'or-drop-zone-icon', 'aria-hidden': 'true' }, icon('cloud-arrow-up')),
    h(
      'div',
      { id: labelId, class: 'fw-semibold' },
      options.label ?? (options.multiple ? 'Drop files here' : 'Drop a file here'),
    ),
    h(
      'div',
      { id: hintId, class: 'small text-body-secondary mb-2' },
      options.hint ?? (accept.length > 0 ? describeAccept(accept) : 'Any file'),
    ),
    button,
    input,
  );

  let depth = 0;
  const hasFiles = (event: DragEvent): boolean =>
    event.dataTransfer?.types.includes('Files') ?? false;
  zone.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    zone.classList.add('is-dragover');
  });
  zone.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) zone.classList.remove('is-dragover');
  });
  zone.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depth = 0;
    zone.classList.remove('is-dragover');
    deliver(event.dataTransfer?.files ?? null);
  });
  return zone;
}
