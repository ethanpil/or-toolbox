/**
 * `attachmentIntake()`: how a tool takes files into a request, next to the chips that show them
 * (`attachmentChip`). Chat's composer and Model arena's prompt use it: dropped, pasted and chosen files, and what
 * "Send to…" hands over, with the same limits and the same wording. Only the noun differs ("message", "prompt").
 *
 * ```ts
 * const intake = attachmentIntake({
 *   noun: 'prompt',
 *   files: () => files,
 *   setFiles: (next) => { files = next; },
 *   keep: (id, data) => session.set(id, data),   // bytes of images, PDFs and audio, in memory only
 *   field: promptInput,                          // where text sent from another tool goes
 *   changed: () => { renderFiles(); void ui.refreshEstimate(); },
 * });
 * // in the instance: onFiles: (list) => void intake.addFiles(list), onReceive: (items) => intake.receive(items)
 * ```
 *
 * Files that cannot be attached (too many, too big, unreadable) are named together in one warning toast; the
 * others are kept. `changed` runs after every batch, so the tool redraws its chips and its estimate there.
 */
import {
  type AttachmentRef,
  checkText,
  MAX_ATTACHMENTS,
  readAttachment,
  SIZE_LIMITS,
  textAttachment,
} from '../../core/attachments/attachments';
import { InvalidInputError, userMessage } from '../../core/errors';
import { announce } from '../feedback/announce';
import { toast } from '../feedback/toast';
import { formatBytes, plural } from '../format';
import type { SendItem } from '../tool/types';

export interface AttachmentIntakeOptions {
  /** What the files go with, as the limits' messages say it: "message", "prompt". */
  noun: string;
  /** The files attached so far. */
  files: () => readonly AttachmentRef[];
  setFiles: (next: AttachmentRef[]) => void;
  /** Keeps the bytes (a data URL) of an image, PDF or audio file for the session; text files carry their text. */
  keep: (id: string, data: string) => void;
  /** The typed-text field that unnamed text sent from another tool is added to. */
  field: { value: string };
  /** Something changed (files attached, text added): redraw the chips, refresh the estimate. */
  changed: () => void;
}

export interface AttachmentIntake {
  /** Adds one file within the limits; throws `InvalidInputError` when it does not fit. */
  attach(ref: AttachmentRef, data?: string): void;
  /** Reads and attaches files (dropped, pasted or chosen), one warning for everything that failed. */
  addFiles(files: File[]): Promise<void>;
  /** "Send to…": files and named text become attachments, other text is added to the field. */
  receive(items: SendItem[]): void;
}

export function attachmentIntake(options: AttachmentIntakeOptions): AttachmentIntake {
  const { noun } = options;

  const full = (): InvalidInputError =>
    new InvalidInputError(`At most ${MAX_ATTACHMENTS} files go with one ${noun}.`);

  function attach(ref: AttachmentRef, data?: string): void {
    const current = options.files();
    if (current.length >= MAX_ATTACHMENTS) throw full();
    if (ref.kind === 'text') checkText(current, ref.name, ref.size, noun);
    if (data) options.keep(ref.id, data);
    options.setFiles([...current, ref]);
  }

  const warn = (problems: string[]): void => {
    toast({ variant: 'warning', message: problems.join(' '), testId: 'attach-error' });
  };

  async function addFiles(files: File[]): Promise<void> {
    const problems: string[] = [];
    let added = 0;
    for (const file of files) {
      try {
        // Before reading: a file that cannot be attached is not worth reading.
        if (options.files().length >= MAX_ATTACHMENTS) throw full();
        const { ref, data } = await readAttachment(file);
        attach(ref, data);
        added++;
      } catch (error) {
        problems.push(userMessage(error));
      }
    }
    options.changed();
    if (problems.length > 0) warn(problems);
    else if (added > 0) announce(`${plural(added, 'file')} attached.`);
  }

  function receive(items: SendItem[]): void {
    const files: File[] = [];
    const problems: string[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        files.push(new File([item.blob], item.name, { type: item.blob.type }));
        continue;
      }
      try {
        if (item.name) attach(textAttachment(item.name, item.text, item.type));
        else {
          const size = new Blob([item.text]).size;
          if (size > SIZE_LIMITS.text) {
            throw new InvalidInputError(
              `The text sent here is ${formatBytes(size)}. A ${noun} takes at most ${formatBytes(SIZE_LIMITS.text)} of typed text; send it as a file instead.`,
            );
          }
          options.field.value = [options.field.value, item.text].filter(Boolean).join('\n\n');
        }
      } catch (error) {
        problems.push(userMessage(error));
      }
    }
    options.changed();
    if (problems.length > 0) warn(problems);
    if (files.length > 0) void addFiles(files);
  }

  return { attach, addFiles, receive };
}
