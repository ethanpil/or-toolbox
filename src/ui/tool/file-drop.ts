/**
 * Page-wide file drop and paste for tool pages. Dragging files anywhere over the page shows a full-page overlay
 * naming the tool and what it accepts; dropping (or pasting files with Ctrl/Cmd+V) hands the accepted files to
 * the tool and names the skipped ones in a toast. A paste into a text field that also carries text is left to
 * the field. Drop zones inside the page handle their own drops first.
 */
import { h } from '../dom';
import { toast } from '../feedback/toast';
import { plural } from '../format';
import { icon } from '../icon';
import { describeAccept, partitionFiles } from '../components/file-types';

export interface FileDropOptions {
  accept: readonly string[];
  toolName: string;
  onFiles: (files: File[]) => void;
}

const hasFiles = (event: DragEvent): boolean =>
  event.dataTransfer?.types.includes('Files') ?? false;

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement &&
      !['checkbox', 'radio', 'button', 'file'].includes(target.type)));

export function installFileDrop(options: FileDropOptions): void {
  const overlay = h(
    'div',
    {
      class: 'or-drop-overlay',
      hidden: true,
      'aria-hidden': 'true',
      'data-testid': 'drop-overlay',
    },
    h(
      'div',
      { class: 'or-drop-overlay-panel' },
      h('div', { class: 'or-drop-zone-icon mb-2' }, icon('cloud-arrow-up')),
      h('div', { class: 'h5 mb-1' }, `Drop to add to ${options.toolName}`),
      h('div', { class: 'text-body-secondary' }, describeAccept(options.accept)),
    ),
  );
  document.body.append(overlay);

  const deliver = (files: File[]): void => {
    if (files.length === 0) return;
    const { accepted, rejected } = partitionFiles(files, options.accept);
    if (accepted.length > 0) options.onFiles(accepted);
    if (rejected.length > 0) {
      toast({
        variant: 'warning',
        message: `Skipped ${plural(rejected.length, 'file')}: ${options.toolName} accepts ${describeAccept(options.accept)}.`,
      });
    }
  };

  let depth = 0;
  const hide = (): void => {
    depth = 0;
    overlay.hidden = true;
  };
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener('drop', (event) => {
    hide();
    if (!hasFiles(event)) return;
    event.preventDefault();
    deliver([...(event.dataTransfer?.files ?? [])]);
  });
  // A drop handled (and stopped) by a drop zone never reaches window: hide the overlay anyway.
  document.addEventListener('drop', hide, { capture: true });

  document.addEventListener('paste', (event) => {
    const data = event.clipboardData;
    const files = [...(data?.files ?? [])];
    if (files.length === 0) return;
    if (isEditable(event.target) && data?.types.includes('text/plain')) return;
    event.preventDefault();
    deliver(files);
  });
}
