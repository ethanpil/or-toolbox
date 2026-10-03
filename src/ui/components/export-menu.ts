/**
 * `exportMenu()`: a Download button, or a Download dropdown when there are several formats. Each format's Blob
 * is built only when chosen (so DOCX/XLSX writers load on demand), saved with `downloadBlob`, and the session
 * results named by `resultIds` are marked downloaded (which releases the leave guard for them).
 *
 * Change it with `menu.update(formats)` or `menu.update({ formats, disabled })` instead of building a new one:
 * the toggle and the list stay in place, so a menu the user has open stays open (it closes only when disabled).
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
import { Dropdown } from '../bootstrap';
import { h, replace } from '../dom';
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

export interface ExportMenuUpdate {
  formats?: readonly ExportFormat[];
  disabled?: boolean;
}

/** The menu's element, with `update` to change it without rebuilding (an open menu stays open). */
export type ExportMenu = HTMLElement & {
  update(next: readonly ExportFormat[] | ExportMenuUpdate): void;
};

export function exportMenu(options: ExportMenuOptions): ExportMenu {
  const label = options.label ?? 'Download';
  const testId = options.testId ?? 'export-menu';
  let formats: readonly ExportFormat[] = options.formats;
  let disabled = options.disabled ?? false;

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
      // The single button follows the menu's disabled state; menu items are only busy while saving.
      trigger.disabled = trigger === single ? disabled : false;
    }
  };

  // One format: a plain button. Several: a dropdown. Both are built once and swapped as the formats change.
  const single: HTMLButtonElement = h('button', {
    type: 'button',
    class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
    'data-testid': testId,
    onclick: () => {
      const format = formats[0];
      if (format) void save(format, single);
    },
  });
  const toggle = h(
    'button',
    {
      type: 'button',
      class:
        'btn btn-sm btn-outline-secondary dropdown-toggle d-inline-flex align-items-center gap-1',
      'data-bs-toggle': 'dropdown',
      'aria-expanded': 'false',
      'data-testid': testId,
    },
    icon('download'),
    label,
  );
  const list = h('ul', { class: 'dropdown-menu shadow' });
  const item = (format: ExportFormat): HTMLElement => {
    const button: HTMLButtonElement = h(
      'button',
      {
        type: 'button',
        class: 'dropdown-item d-flex align-items-center gap-2',
        'data-focus-key': `export:${format.extension}`,
        'data-testid': `export-${format.extension}`,
        onclick: () => void save(format, button),
      },
      icon(format.icon ?? 'file-earmark'),
      format.label,
      h('span', { class: 'ms-auto ps-3 small text-body-secondary' }, `.${format.extension}`),
    );
    return h('li', null, button);
  };

  const root = h('div', { class: 'dropdown d-inline-block' });
  let mode: 'single' | 'menu' | null = null;

  const draw = (): void => {
    const next = formats.length === 1 ? 'single' : 'menu';
    if (next !== mode) {
      if (mode === 'menu') Dropdown.getInstance(toggle)?.hide();
      root.replaceChildren(...(next === 'single' ? [single] : [toggle, list]));
      mode = next;
    }
    if (mode === 'single') {
      single.replaceChildren(icon('download'), `${label} .${formats[0]!.extension}`);
      single.disabled = disabled;
      return;
    }
    const off = disabled || formats.length === 0;
    if (off) Dropdown.getInstance(toggle)?.hide();
    toggle.disabled = off;
    // In place: the toggle and the list stay, so an open menu stays open and a focused item keeps focus.
    replace(list, formats.map(item));
  };

  draw();
  return Object.assign(root, {
    update(next: readonly ExportFormat[] | ExportMenuUpdate): void {
      if (Array.isArray(next)) formats = next as readonly ExportFormat[];
      else {
        const patch = next as ExportMenuUpdate;
        if (patch.formats) formats = patch.formats;
        if (patch.disabled !== undefined) disabled = patch.disabled;
      }
      draw();
    },
  });
}
