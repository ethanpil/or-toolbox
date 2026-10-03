/**
 * `outputPanel()`: where a text-producing tool shows its result. Streams text or Markdown as it arrives
 * (Markdown re-rendered through `renderMarkdown`, throttled), shows skeleton placeholders until the first chunk,
 * announces start and finish through a status line (never the streamed text itself), and offers Copy,
 * Download (format menu) and Send to….
 *
 * ```ts
 * const out = outputPanel({ format: 'markdown', filename: 'answer', sendTo: ctx.ui.sendTo });
 * ctx.ui.output.append(out.element);
 * out.start();
 * await ctx.api.chatStream(body, { run, onEvent: (e) => e.type === 'text' && out.append(e.text) });
 * out.finish();
 * ```
 */
import { h } from '../dom';
import { announce } from '../feedback/announce';
import { toast } from '../feedback/toast';
import { copyText } from '../clipboard';
import { icon } from '../icon';
import { renderMarkdown } from '../markdown';
import type { SendItem } from '../tool/types';
import { emptyState } from './empty-state';
import { type ExportFormat, exportMenu } from './export-menu';

export interface OutputPanelOptions {
  format?: 'markdown' | 'text';
  /** Shown before the first run. */
  empty?: { icon?: string; title?: string; text?: string };
  /** Download file name without extension. */
  filename?: string | (() => string);
  /** Replaces the default formats (Markdown, text and Word for Markdown; text for text). */
  formats?: ExportFormat[];
  /** Usually `ctx.ui.sendTo`; omit to hide "Send to…". */
  sendTo?: (items: SendItem[]) => void;
  /** Accessible name of the output region. */
  label?: string;
}

export interface OutputPanel {
  readonly element: HTMLElement;
  /** Clears the output and shows the skeleton until the first chunk. */
  start(status?: string): void;
  append(chunk: string): void;
  /** Replaces the whole text (e.g. a non-streaming result). */
  setText(text: string): void;
  /** Final render; enables the actions. */
  finish(status?: string): void;
  /** Keeps any partial text and shows `message` as an error line. */
  fail(message: string): void;
  /** Back to the empty state. */
  clear(): void;
  text(): string;
  setStatus(text: string): void;
}

const RENDER_INTERVAL_MS = 100;

export function outputPanel(options: OutputPanelOptions = {}): OutputPanel {
  const markdown = (options.format ?? 'markdown') === 'markdown';
  let buffer = '';
  let streaming = false;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let renderSeq = 0;
  /** The error line shown after the (partial) text, kept across re-renders. */
  let errorLine: HTMLElement | null = null;

  const content = h('div', {
    class: ['or-output-content', markdown ? 'or-markdown' : 'or-plain-text'],
    role: 'region',
    'aria-label': options.label ?? 'Output',
    'aria-busy': 'false',
    tabIndex: 0,
    'data-testid': 'output-content',
  });
  const statusLine = h('div', {
    class: 'small text-body-secondary me-auto',
    role: 'status',
    'data-testid': 'output-status',
  });

  const copyButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
      'data-testid': 'output-copy',
      onclick: () => {
        void copyText(buffer).then((ok) =>
          toast(
            ok
              ? { message: 'Copied to the clipboard.', variant: 'success' }
              : { message: 'Copying was blocked by the browser.', variant: 'warning' },
          ),
        );
      },
    },
    icon('clipboard'),
    'Copy',
  );

  const stem = (): string =>
    (typeof options.filename === 'function' ? options.filename() : options.filename) ?? 'output';
  const formats: ExportFormat[] =
    options.formats ??
    (markdown
      ? [
          {
            label: 'Markdown',
            extension: 'md',
            icon: 'markdown',
            build: () => new Blob([buffer], { type: 'text/markdown' }),
          },
          {
            label: 'Plain text',
            extension: 'txt',
            icon: 'file-earmark-text',
            build: () => new Blob([buffer], { type: 'text/plain' }),
          },
          {
            label: 'Word document',
            extension: 'docx',
            icon: 'file-earmark-word',
            build: async () => (await import('../../core/export/docx')).toDocx(buffer),
          },
        ]
      : [
          {
            label: 'Text',
            extension: 'txt',
            build: () => new Blob([buffer], { type: 'text/plain' }),
          },
        ]);
  const download = h('span', { class: 'd-inline-block' });
  const sendButton = options.sendTo
    ? h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
          'data-testid': 'output-send',
          onclick: () =>
            options.sendTo?.([
              {
                kind: 'text',
                text: buffer,
                type: markdown ? 'text/markdown' : 'text/plain',
                name: `${stem()}.${markdown ? 'md' : 'txt'}`,
              },
            ]),
        },
        icon('send'),
        'Send to…',
      )
    : null;

  const actions = h('div', { class: 'd-flex flex-wrap gap-2' }, copyButton, download, sendButton);
  const setActionsEnabled = (enabled: boolean): void => {
    copyButton.disabled = !enabled;
    if (sendButton) sendButton.disabled = !enabled;
    download.replaceChildren(
      exportMenu({ formats, filename: stem, disabled: !enabled, testId: 'output-download' }),
    );
  };

  const element = h(
    'div',
    { class: 'or-output', 'data-testid': 'output-panel' },
    content,
    h(
      'div',
      { class: 'or-output-footer d-flex flex-wrap align-items-center gap-2 pt-3 mt-3 border-top' },
      statusLine,
      actions,
    ),
  );

  const showEmpty = (): void => {
    content.replaceChildren(
      emptyState({
        icon: options.empty?.icon ?? 'stars',
        title: options.empty?.title ?? 'Nothing here yet',
        text: options.empty?.text ?? 'Run the tool and the result appears here.',
        compact: true,
        testId: 'output-empty',
      }),
    );
  };

  const skeleton = (): HTMLElement =>
    h(
      'div',
      { class: 'placeholder-glow', 'aria-hidden': 'true', 'data-testid': 'output-skeleton' },
      ['col-9', 'col-11', 'col-7', 'col-10', 'col-5'].map((width) =>
        h('span', { class: `placeholder ${width} d-block mb-2 rounded` }),
      ),
    );

  const renderNow = async (): Promise<void> => {
    renderTimer = undefined;
    const seq = ++renderSeq;
    const caret = streaming ? h('span', { class: 'or-caret', 'aria-hidden': 'true' }) : null;
    if (!markdown) {
      content.replaceChildren(buffer, caret ?? '', errorLine ?? '');
      return;
    }
    try {
      const fragment = await renderMarkdown(buffer);
      if (seq !== renderSeq) return; // a newer render started meanwhile
      content.replaceChildren(fragment, caret ?? '', errorLine ?? '');
    } catch {
      if (seq === renderSeq) content.replaceChildren(buffer, errorLine ?? '');
    }
  };

  const scheduleRender = (): void => {
    renderTimer ??= setTimeout(() => void renderNow(), RENDER_INTERVAL_MS);
  };

  const setStatus = (text: string): void => {
    statusLine.textContent = text;
  };

  const words = (): number => buffer.trim().split(/\s+/).filter(Boolean).length;

  showEmpty();
  setActionsEnabled(false);

  return {
    element,
    start(status = 'Generating…') {
      buffer = '';
      errorLine = null;
      streaming = true;
      clearTimeout(renderTimer);
      renderTimer = undefined;
      renderSeq++;
      content.setAttribute('aria-busy', 'true');
      content.replaceChildren(skeleton());
      setActionsEnabled(false);
      setStatus(status);
      announce(status);
    },
    append(chunk) {
      if (!chunk) return;
      buffer += chunk;
      scheduleRender();
    },
    setText(text) {
      buffer = text;
      scheduleRender();
    },
    finish(status) {
      streaming = false;
      clearTimeout(renderTimer);
      void renderNow();
      content.setAttribute('aria-busy', 'false');
      const done =
        status ??
        (buffer
          ? `Done · ${words().toLocaleString('en-US')} words`
          : 'Done, but the model returned no text.');
      setStatus(done);
      announce(done);
      setActionsEnabled(buffer.length > 0);
    },
    fail(message) {
      streaming = false;
      clearTimeout(renderTimer);
      content.setAttribute('aria-busy', 'false');
      errorLine = h(
        'div',
        { class: 'alert alert-danger d-flex gap-2 mt-3 mb-0', 'data-testid': 'output-error' },
        icon('exclamation-octagon'),
        h('div', null, message),
      );
      void renderNow();
      announce(message, { assertive: true });
      setStatus(buffer ? 'Stopped with an error; the partial result is kept.' : 'Failed.');
      setActionsEnabled(buffer.length > 0);
    },
    clear() {
      buffer = '';
      errorLine = null;
      streaming = false;
      clearTimeout(renderTimer);
      renderSeq++;
      content.setAttribute('aria-busy', 'false');
      showEmpty();
      setStatus('');
      setActionsEnabled(false);
    },
    text: () => buffer,
    setStatus,
  };
}
