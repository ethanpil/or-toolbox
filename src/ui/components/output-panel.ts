/**
 * `outputPanel()`: where a text-producing tool shows its result. Streams text or Markdown as it arrives, shows
 * skeleton placeholders until the first chunk, announces start and finish through a status line (never the
 * streamed text itself), and offers Copy, Download (format menu) and Send to….
 *
 * Streaming Markdown stays cheap and never stalls: blocks that are complete (up to the last blank line outside a
 * code fence) are rendered once and kept; only the unfinished tail is re-rendered. One render runs at a time;
 * text that arrives meanwhile is drawn as soon as it finishes, paced by how long renders take. `finish()` draws
 * the whole text once more, so the final result is exactly what `renderMarkdown` makes of it.
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

/** Pause between streaming renders: twice the last render's cost, within these bounds. */
const MIN_RENDER_GAP_MS = 50;
const MAX_RENDER_GAP_MS = 500;

/**
 * Where the stable part of streamed Markdown ends: just after the last blank line that is not inside a code
 * fence, scanning from `from` (a position already known to be outside a fence). Returns `from` when there is
 * none yet.
 */
export function stableBoundary(text: string, from: number): number {
  let boundary = from;
  let inFence = false;
  let lineStart = from;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    if (newline === -1) break; // the last line is unfinished: never part of the stable prefix
    const line = text.slice(lineStart, newline);
    if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && line.trim() === '' && lineStart > from) boundary = newline + 1;
    lineStart = newline + 1;
  }
  return boundary;
}

export function outputPanel(options: OutputPanelOptions = {}): OutputPanel {
  const markdown = (options.format ?? 'markdown') === 'markdown';
  let buffer = '';
  let streaming = false;
  /** Bumped by start()/clear(): renders of an older run never touch the panel. */
  let generation = 0;
  /** The error line shown after the (partial) text, kept across re-renders. */
  let errorLine: HTMLElement | null = null;
  // Streaming Markdown: blocks up to `stableUpTo` are rendered once into `stableEl`; the rest goes to `tailEl`.
  let stableUpTo = 0;
  const stableEl = h('div', { class: 'or-output-stable' });
  const tailEl = h('div', { class: 'or-output-tail' });
  let loop: Promise<void> | null = null;
  let loopGeneration = -1;
  let dirty = false;
  let lastCost = 0;

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

  const caret = (): HTMLElement | null =>
    streaming ? h('span', { class: 'or-caret', 'aria-hidden': 'true' }) : null;

  /** Draws what has arrived: new stable blocks once, the tail again. */
  const renderOnce = async (gen: number): Promise<void> => {
    if (!markdown) {
      content.replaceChildren(buffer, caret() ?? '', errorLine ?? '');
      return;
    }
    if (!stableEl.isConnected) content.replaceChildren(stableEl, tailEl);
    const boundary = stableBoundary(buffer, stableUpTo);
    if (boundary > stableUpTo) {
      const fragment = await renderMarkdown(buffer.slice(stableUpTo, boundary));
      if (gen !== generation) return;
      stableEl.append(fragment);
      stableUpTo = boundary;
    }
    const tail = await renderMarkdown(buffer.slice(stableUpTo));
    if (gen !== generation) return;
    tailEl.replaceChildren(tail, caret() ?? '');
    if (errorLine) content.append(errorLine);
  };

  /** Runs renders back to back while text keeps arriving; one at a time, paced by their cost. */
  const scheduleRender = (): void => {
    dirty = true;
    if (loop && loopGeneration === generation) return;
    const gen = generation;
    const previous = loop; // a loop of an older run ends at its next check; start after it
    loopGeneration = gen;
    loop = (async () => {
      await previous;
      try {
        while (dirty && gen === generation) {
          dirty = false;
          const started = performance.now();
          try {
            await renderOnce(gen);
          } catch {
            if (gen === generation) content.replaceChildren(buffer, errorLine ?? '');
          }
          lastCost = performance.now() - started;
          if (dirty && streaming) {
            const gap = Math.min(MAX_RENDER_GAP_MS, Math.max(MIN_RENDER_GAP_MS, lastCost * 2));
            await new Promise((resolve) => setTimeout(resolve, gap));
          }
        }
      } finally {
        if (loopGeneration === gen) loop = null;
      }
    })();
  };

  /** The whole text in one render: what the result finally looks like. */
  const renderFinal = async (gen: number): Promise<void> => {
    await loop;
    if (gen !== generation) return;
    if (!markdown) {
      content.replaceChildren(buffer, errorLine ?? '');
      return;
    }
    try {
      const fragment = await renderMarkdown(buffer);
      if (gen !== generation) return;
      content.replaceChildren(fragment, errorLine ?? '');
    } catch {
      if (gen === generation) content.replaceChildren(buffer, errorLine ?? '');
    }
  };

  const reset = (): void => {
    generation++;
    dirty = false;
    stableUpTo = 0;
    stableEl.replaceChildren();
    tailEl.replaceChildren();
    errorLine = null;
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
      reset();
      buffer = '';
      streaming = true;
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
      // A replaced text may differ anywhere: draw it from scratch.
      const keepError = errorLine;
      reset();
      errorLine = keepError;
      buffer = text;
      scheduleRender();
    },
    finish(status) {
      streaming = false;
      content.setAttribute('aria-busy', 'false');
      void renderFinal(generation);
      const done =
        status ??
        (buffer ? `Done · ${formatInt(words())} words` : 'Done, but the model returned no text.');
      setStatus(done);
      announce(done);
      setActionsEnabled(buffer.length > 0);
    },
    fail(error) {
      streaming = false;
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
      void renderFinal(generation);
      setActionsEnabled(kept);
    },
    clear() {
      reset();
      buffer = '';
      streaming = false;
      content.setAttribute('aria-busy', 'false');
      showEmpty();
      setStatus('');
      setActionsEnabled(false);
    },
    text: () => buffer,
    setStatus,
  };
}
