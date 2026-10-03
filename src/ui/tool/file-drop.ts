/**
 * Page-wide file drop and paste for tool pages, installed before the tool's own setup runs so that a stray drop
 * can never make the browser open the file and leave the page (taking any unsaved results with it).
 *
 * - Every file drag over the page is accepted by the page (the browser's default would navigate to the file).
 * - While the tool takes files (`onFiles` and a non-empty `accepts`), a full-page overlay names the tool and what
 *   it accepts; a drop or a paste hands the accepted files to it and names the skipped ones in a toast.
 * - Otherwise a drop says "This tool doesn't take files". A paste into a text field that also carries text is
 *   left to the field. Drop zones inside the page handle their own drops first.
 */
import { h } from '../dom';
import { toast } from '../feedback/toast';
import { plural } from '../format';
import { icon } from '../icon';
import { describeAccept, partitionFiles } from '../components/file-types';

export interface FileDropOptions {
  accept: readonly string[];
  toolName: string;
  /** The tool's file handler once it has one (null before setup, or for tools that take no files). */
  handler: () => ((files: File[]) => void) | null;
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
  const takesFiles = (): ((files: File[]) => void) | null =>
    options.accept.length > 0 ? options.handler() : null;

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
    const handler = takesFiles();
    if (!handler) {
      toast({ variant: 'warning', message: `${options.toolName} doesn't take files.` });
      return;
    }
    const { accepted, rejected } = partitionFiles(files, options.accept);
    if (accepted.length > 0) handler(accepted);
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
    if (takesFiles()) overlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    // Always: without it the browser opens the dropped file in place of the page. The drop is allowed even when
    // the tool takes no files, so it can say so instead of silently refusing.
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
