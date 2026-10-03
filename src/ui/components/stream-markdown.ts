/**
 * `streamMarkdown(target, options)`: draws streamed Markdown (or plain text) into `target` as it arrives, without
 * any chrome. `outputPanel` is built on it; tools with their own layout (Chat replies, Bot-to-bot turns, Model
 * arena contenders) use it directly, one stream per bubble.
 *
 * - Cheap on long answers: blocks that are complete (up to the last blank line outside a code fence) are rendered
 *   once and kept; only the unfinished tail is re-rendered.
 * - Never stalls and never drops text: one render runs at a time; text that arrives meanwhile is drawn as soon as
 *   it finishes, with a pause of twice the last render's cost (50 to 500 ms) while streaming.
 * - `finish()` draws the whole text once more, so the result is exactly what `renderMarkdown` makes of it.
 * - Nothing touches `target` before the first `append`/`set`/`finish` (a skeleton placed there stays until then),
 *   and nothing after `dispose()`.
 *
 * ```ts
 * const stream = streamMarkdown(bubble, { onRender: () => keepScrolledToBottom() });
 * await ctx.api.chatStream(body, { run, onEvent: (e) => e.type === 'text' && stream.append(e.text) });
 * await stream.finish();
 * ```
 */
import { h } from '../dom';
import { renderMarkdown } from '../markdown';

export interface StreamMarkdownOptions {
  /** Default `markdown`; `text` draws the text as is. */
  format?: 'markdown' | 'text';
  /** A blinking caret after the text while streaming. Default true. */
  caret?: boolean;
  /** A node kept after the text on every draw (e.g. an inline error line), or null. */
  after?: () => Node | null;
  /** Called after every draw (e.g. to keep a conversation scrolled to the bottom). */
  onRender?: () => void;
}

export interface MarkdownStream {
  /** Adds streamed text; drawn shortly. */
  append(chunk: string): void;
  /** Replaces the whole text (it may differ anywhere) and redraws from scratch. */
  set(text: string): void;
  /** Everything appended or set so far. */
  text(): string;
  /** Ends streaming: draws the whole text once more (no caret). Resolves when it is on screen. */
  finish(): Promise<void>;
  /** Stops drawing into `target` for good; renders still pending are dropped. */
  dispose(): void;
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

export function streamMarkdown(
  target: HTMLElement,
  options: StreamMarkdownOptions = {},
): MarkdownStream {
  const markdown = (options.format ?? 'markdown') === 'markdown';
  let buffer = '';
  let streaming = true;
  let disposed = false;
  /** Bumped by set() and dispose(): a render of an older text never touches the target. */
  let generation = 0;
  // Blocks up to `stableUpTo` are rendered once into `stableEl`; the rest is redrawn into `tailEl`.
  let stableUpTo = 0;
  const stableEl = h('div', { class: 'or-output-stable' });
  const tailEl = h('div', { class: 'or-output-tail' });
  let loop: Promise<void> | null = null;
  let loopGeneration = -1;
  let dirty = false;
  let lastCost = 0;

  const alive = (gen: number): boolean => !disposed && gen === generation;
  const caret = (): HTMLElement | null =>
    streaming && options.caret !== false
      ? h('span', { class: 'or-caret', 'aria-hidden': 'true' })
      : null;
  const after = (): Node | string => options.after?.() ?? '';
  const rendered = (): void => options.onRender?.();

  /** Draws what has arrived: new stable blocks once, the tail again. */
  const renderOnce = async (gen: number): Promise<void> => {
    if (!markdown) {
      target.replaceChildren(buffer, caret() ?? '', after());
      rendered();
      return;
    }
    if (stableEl.parentNode !== target) target.replaceChildren(stableEl, tailEl);
    const boundary = stableBoundary(buffer, stableUpTo);
    if (boundary > stableUpTo) {
      const fragment = await renderMarkdown(buffer.slice(stableUpTo, boundary));
      if (!alive(gen)) return;
      stableEl.append(fragment);
      stableUpTo = boundary;
    }
    const tail = await renderMarkdown(buffer.slice(stableUpTo));
    if (!alive(gen)) return;
    tailEl.replaceChildren(tail, caret() ?? '');
    const extra = options.after?.();
    if (extra) target.append(extra);
    rendered();
  };

  /** Runs renders back to back while text keeps arriving; one at a time, paced by their cost. */
  const scheduleRender = (): void => {
    dirty = true;
    if (loop && loopGeneration === generation) return;
    const gen = generation;
    const previous = loop; // a loop of an older text ends at its next check; start after it
    loopGeneration = gen;
    loop = (async () => {
      await previous;
      try {
        while (dirty && alive(gen)) {
          dirty = false;
          const started = performance.now();
          try {
            await renderOnce(gen);
          } catch {
            if (alive(gen)) target.replaceChildren(buffer, after());
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

  const restart = (): void => {
    generation++;
    dirty = false;
    stableUpTo = 0;
    stableEl.replaceChildren();
    tailEl.replaceChildren();
  };

  return {
    append(chunk) {
      if (!chunk || disposed) return;
      buffer += chunk;
      scheduleRender();
    },
    set(text) {
      if (disposed) return;
      restart();
      buffer = text;
      scheduleRender();
    },
    text: () => buffer,
    async finish() {
      streaming = false;
      dirty = false;
      const gen = generation;
      await loop;
      if (!alive(gen)) return;
      if (!markdown) {
        target.replaceChildren(buffer, after());
        rendered();
        return;
      }
      try {
        const fragment = await renderMarkdown(buffer);
        if (!alive(gen)) return;
        target.replaceChildren(fragment, after());
      } catch {
        if (alive(gen)) target.replaceChildren(buffer, after());
      }
      rendered();
    },
    dispose() {
      disposed = true;
      generation++;
      dirty = false;
    },
  };
}
