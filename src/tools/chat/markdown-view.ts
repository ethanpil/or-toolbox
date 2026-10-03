/**
 * Markdown for chat replies: a cache of rendered (sanitised) replies, so re-drawing a conversation does not parse
 * every reply again, a Copy button on every code block, and a streaming renderer that draws complete blocks once
 * and re-renders only the unfinished tail (the output panel's approach, `stableBoundary`).
 *
 * Code-block Copy buttons carry `data-copy-code`; the conversation handles their clicks by delegation, so cloned
 * fragments from the cache work without listeners of their own.
 */
import { stableBoundary } from '../../ui/components/output-panel';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icon';
import { renderMarkdown } from '../../ui/markdown';

/** Rendered replies are kept for this many replies. */
const CACHE_SIZE = 200;
const cache = new Map<string, { text: string; fragment: DocumentFragment }>();

/** Wraps each `<pre>` with a Copy button (idempotent). */
export function addCodeCopyButtons(root: ParentNode): void {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.parentElement?.classList.contains('or-code-block')) continue;
    const wrap = h('div', { class: 'or-code-block' });
    pre.replaceWith(wrap);
    wrap.append(
      pre,
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-secondary or-code-copy',
          'data-copy-code': '',
          'aria-label': 'Copy code',
          'data-testid': 'code-copy',
        },
        icon('clipboard'),
      ),
    );
  }
}

/** The text a code-block Copy button copies. */
export function codeOf(button: Element): string {
  return button.closest('.or-code-block')?.querySelector('pre')?.textContent ?? '';
}

/** Rendered Markdown for `key` (a message id); a cached copy when `text` is unchanged. */
export async function renderReply(key: string, text: string): Promise<DocumentFragment> {
  const hit = cache.get(key);
  if (hit?.text === text) return hit.fragment.cloneNode(true) as DocumentFragment;
  const fragment = await renderMarkdown(text);
  addCodeCopyButtons(fragment);
  cache.delete(key);
  cache.set(key, { text, fragment: fragment.cloneNode(true) as DocumentFragment });
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return fragment;
}

/** A cached render, synchronously, or null (then call `renderReply`). */
export function cachedReply(key: string, text: string): DocumentFragment | null {
  const hit = cache.get(key);
  return hit?.text === text ? (hit.fragment.cloneNode(true) as DocumentFragment) : null;
}

/** What each target was last asked to show, so a slow render never overwrites a newer one. */
const wanted = new WeakMap<HTMLElement, string>();

/** Fills `target` with the rendered reply; plain text until it is rendered, or if rendering fails. */
export function fillReply(target: HTMLElement, key: string, text: string): void {
  wanted.set(target, text);
  const cached = cachedReply(key, text);
  if (cached) {
    target.replaceChildren(cached);
    return;
  }
  target.textContent = text;
  renderReply(key, text)
    .then((fragment) => {
      if (wanted.get(target) === text) target.replaceChildren(fragment);
    })
    .catch(() => undefined);
}

export interface StreamingView {
  /** The whole text so far. */
  update(text: string): void;
  /** Stops drawing (the caller draws the final text). */
  close(): void;
}

const MIN_GAP_MS = 50;
const MAX_GAP_MS = 500;

/** Draws streamed Markdown into `target`: stable blocks once, the unfinished tail again, paced by render cost. */
export function streamingView(target: HTMLElement): StreamingView {
  let text = '';
  let stableUpTo = 0;
  let dirty = false;
  let running = false;
  let closed = false;
  const stable = h('div');
  const tail = h('div');
  const caret = h('span', { class: 'or-caret', 'aria-hidden': 'true' });
  target.replaceChildren(stable, tail, caret);

  const drawOnce = async (): Promise<void> => {
    const boundary = stableBoundary(text, stableUpTo);
    if (boundary > stableUpTo) {
      const fragment = await renderMarkdown(text.slice(stableUpTo, boundary));
      if (closed) return;
      addCodeCopyButtons(fragment);
      stable.append(fragment);
      stableUpTo = boundary;
    }
    const rest = await renderMarkdown(text.slice(stableUpTo));
    if (closed) return;
    addCodeCopyButtons(rest);
    tail.replaceChildren(rest);
  };

  const loop = async (): Promise<void> => {
    running = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        const started = performance.now();
        try {
          await drawOnce();
        } catch {
          if (!closed) tail.textContent = text.slice(stableUpTo);
        }
        if (dirty && !closed) {
          const gap = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, (performance.now() - started) * 2));
          await new Promise((resolve) => setTimeout(resolve, gap));
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    update(next) {
      text = next;
      dirty = true;
      if (!running) void loop();
    },
    close() {
      closed = true;
      caret.remove();
    },
  };
}
