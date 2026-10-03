/**
 * `exportMenu()`: a Download button, or a Download dropdown when there are several formats. Each format's Blob
 * is built only when chosen (so DOCX/XLSX writers load on demand), saved with `downloadBlob`, and the session
 * results named by `resultIds` are marked downloaded (which releases the leave guard for them).
 *
 * ```ts
 * exportMenu({
 *   filename: 'transcript',
 *   formats: [
 *     { label: 'Text', extension: 'txt', build: () => new Blob([text], { type: 'text/plain' }) },
 *     { label: 'Word', extension: 'docx', build: () => toDocx(markdown) },
 *   ],
 * });
 * ```
 */
import { getCore } from '../../core/index';
import { downloadBlob } from '../../core/files';
import { h } from '../dom';
import { presentError } from '../feedback/errors';
import { icon } from '../icon';

export interface ExportFormat {
  /** e.g. "Markdown". */
  label: string;
  /** Without the dot, e.g. `md`. */
  extension: string;
  build: () => Blob | Promise<Blob>;
  icon?: string;
  /** File name without extension for this format only; default the menu's `filename`. */
  filename?: string | (() => string);
}

export interface ExportMenuOptions {
  formats: readonly ExportFormat[];
  /** File name without extension (sanitised on save); a function is read at click time. */
  filename: string | (() => string);
  label?: string;
  /** Session results this download covers. */
  resultIds?: () => readonly string[];
  disabled?: boolean;
  testId?: string;
}

export function exportMenu(options: ExportMenuOptions): HTMLElement {
  const label = options.label ?? 'Download';
  const save = async (format: ExportFormat, trigger: HTMLButtonElement): Promise<void> => {
    trigger.disabled = true;
    try {
      const blob = await format.build();
      const name = format.filename ?? options.filename;
      const stem = typeof name === 'function' ? name() : name;
      downloadBlob(blob, `${stem || 'ortoolbox'}.${format.extension}`);
      const results = getCore().results;
      for (const id of options.resultIds?.() ?? []) results.markDownloaded(id);
    } catch (error) {
      void presentError(error, { retry: () => void save(format, trigger) });
    } finally {
      trigger.disabled = false;
    }
  };

  if (options.formats.length === 1) {
    const format = options.formats[0]!;
    const button: HTMLButtonElement = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
        disabled: options.disabled ?? false,
        'data-testid': options.testId ?? 'export-menu',
        onclick: () => void save(format, button),
      },
      icon('download'),
      `${label} .${format.extension}`,
    );
    return button;
  }

  const toggle = h(
    'button',
    {
      type: 'button',
      class:
        'btn btn-sm btn-outline-secondary dropdown-toggle d-inline-flex align-items-center gap-1',
      'data-bs-toggle': 'dropdown',
      'aria-expanded': 'false',
      disabled: options.disabled ?? false,
      'data-testid': options.testId ?? 'export-menu',
    },
    icon('download'),
    label,
  );
  return h(
    'div',
    { class: 'dropdown d-inline-block' },
    toggle,
    h(
      'ul',
      { class: 'dropdown-menu shadow' },
      options.formats.map((format) => {
        const item: HTMLButtonElement = h(
          'button',
          {
            type: 'button',
            class: 'dropdown-item d-flex align-items-center gap-2',
            'data-testid': `export-${format.extension}`,
            onclick: () => void save(format, item),
          },
          icon(format.icon ?? 'file-earmark'),
          format.label,
          h('span', { class: 'ms-auto ps-3 small text-body-secondary' }, `.${format.extension}`),
        );
        return h('li', null, item);
      }),
    ),
  );
}
