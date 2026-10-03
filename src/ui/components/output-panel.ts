/**
 * `outputPanel()`: where a text-producing tool shows its result. Streams text or Markdown as it arrives, shows
 * skeleton placeholders until the first chunk, announces start and finish through a status line (never the
 * streamed text itself), and offers Copy, Download (format menu) and Send to….
 *
 * The text is drawn by `streamMarkdown` (stream-markdown.ts): complete blocks once, the unfinished tail again,
 * never stalling; `finish()` draws the whole text once more, exactly as `renderMarkdown` makes it. Tools that
 * need streaming without this chrome (chat bubbles) use `streamMarkdown` directly.
 *
 * Errors follow one rule (`fail(error)`): a Stop is silent (the partial text stays, the status says "Stopped"),
 * errors that need a dialog or a setting (no key, locked, free-only, budget, storage) are left to `presentError`,
 * and every other error is shown once, inline, and marked so the runner does not show it again.
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
import { userMessage } from '../../core/errors';
import { announce } from '../feedback/announce';
import { isStop, markPresented, needsAction } from '../feedback/errors';
import { copyWithToast } from '../clipboard';
import { formatInt } from '../format';
import { icon } from '../icon';
import type { SendItem } from '../tool/types';
import { emptyState } from './empty-state';
import { type ExportFormat, exportMenu } from './export-menu';
import { type MarkdownStream, streamMarkdown } from './stream-markdown';

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
  /**
   * Ends a failed or stopped run, keeping any partial text. A Stop shows only a neutral status; errors that need
   * an action are left to `presentError`; others are shown inline once (and not again by the runner).
   */
  fail(error: unknown): void;
  /** Back to the empty state. */
  clear(): void;
  text(): string;
  setStatus(text: string): void;
}

export { stableBoundary } from './stream-markdown';

export function outputPanel(options: OutputPanelOptions = {}): OutputPanel {
  const markdown = (options.format ?? 'markdown') === 'markdown';
  let buffer = '';
  /** The error line shown after the (partial) text, kept across re-renders. */
  let errorLine: HTMLElement | null = null;
  /** Draws the current run's text into `content`; a new run (or clear) disposes it, so old renders never land. */
  let stream: MarkdownStream | null = null;

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
      onclick: () => void copyWithToast(buffer, 'Copied to the clipboard.'),
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
  const download = exportMenu({
    formats,
    filename: stem,
    disabled: true,
    testId: 'output-download',
  });
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
    download.update({ disabled: !enabled });
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

  /** A fresh stream for a new text; the previous one stops drawing. */
  const newStream = (): MarkdownStream => {
    stream?.dispose();
    stream = streamMarkdown(content, {
      format: markdown ? 'markdown' : 'text',
      after: () => errorLine,
    });
    return stream;
  };

  /** The final draw of what is there (also when the text never streamed, e.g. a failure before any chunk). */
  const finalDraw = (): void => {
    const current = stream ?? newStream();
    if (current.text() !== buffer) current.set(buffer);
    void current.finish();
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
      newStream();
      errorLine = null;
      buffer = '';
      content.setAttribute('aria-busy', 'true');
      content.replaceChildren(skeleton());
      setActionsEnabled(false);
      setStatus(status);
      announce(status);
    },
    append(chunk) {
      if (!chunk) return;
      buffer += chunk;
      (stream ?? newStream()).append(chunk);
    },
    setText(text) {
      // A replaced text may differ anywhere: the stream draws it from scratch (the error line stays).
      buffer = text;
      (stream ?? newStream()).set(text);
    },
    finish(status) {
      content.setAttribute('aria-busy', 'false');
      finalDraw();
      const done =
        status ??
        (buffer ? `Done · ${formatInt(words())} words` : 'Done, but the model returned no text.');
      setStatus(done);
      announce(done);
      setActionsEnabled(buffer.length > 0);
    },
    fail(error) {
      content.setAttribute('aria-busy', 'false');
      const kept = buffer.length > 0;
      if (typeof error !== 'string' && isStop(error)) {
        setStatus(kept ? 'Stopped. The partial result is kept.' : 'Stopped.');
        announce('Stopped.');
        markPresented(error);
      } else if (typeof error !== 'string' && needsAction(error)) {
        // presentError shows it with its action (unlock, add a key, budgets…); nothing inline.
        setStatus(kept ? 'Not finished. The partial result is kept.' : 'Not run.');
      } else {
        const message = typeof error === 'string' ? error : userMessage(error);
        if (typeof error !== 'string') markPresented(error);
        errorLine = h(
          'div',
          {
            class: 'alert alert-danger d-flex gap-2 mt-3 mb-0',
            role: 'alert',
            'data-testid': 'output-error',
          },
          icon('exclamation-octagon'),
          h('div', null, message),
        );
        setStatus(kept ? 'Stopped with an error; the partial result is kept.' : 'Failed.');
      }
      finalDraw();
      setActionsEnabled(kept);
    },
    clear() {
      stream?.dispose();
      stream = null;
      errorLine = null;
      buffer = '';
      content.setAttribute('aria-busy', 'false');
      showEmpty();
      setStatus('');
      setActionsEnabled(false);
    },
    text: () => buffer,
    setStatus,
  };
}
