/**
 * `createMarkdownCache()`: rendered (sanitised) Markdown of finished messages, so redrawing a conversation does
 * not parse every message again. Chat's replies and Bot-to-bot's turns use one each.
 *
 * ```ts
 * const replies = createMarkdownCache({ decorate: addCodeCopyButtons });
 * replies.fill(bodyElement, message.id, message.content); // plain text at once, Markdown when ready
 * await replies.prerender(message.id, message.content); // when a message finishes, before its redraw
 * ```
 *
 * Entries are keyed by `key` (a message id) and valid for one `text`; a changed text renders again. Every caller
 * gets its own copy of the DOM, so placing it in the page never empties the cache. A message that is still
 * arriving streams through `streamMarkdown` instead and is cached once it is complete.
 */
import { renderMarkdown } from '../markdown';

export interface MarkdownCacheOptions {
  /** Entries kept; the oldest go first. Default 200. */
  size?: number;
  /** Runs once on each freshly rendered fragment, before it is cached (Chat adds Copy buttons to code blocks). */
  decorate?: (fragment: DocumentFragment) => void;
}

export interface MarkdownCache {
  /** Rendered Markdown for `key`: a copy of the cached render when `text` is unchanged, else a new render. */
  render(key: string, text: string): Promise<DocumentFragment>;
  /** The cached render, synchronously, or null (then call `render`). */
  cached(key: string, text: string): DocumentFragment | null;
  /** Renders into the cache ahead of the redraw. Rejects when rendering fails. */
  prerender(key: string, text: string): Promise<void>;
  /**
   * Fills `target` with the rendered text: at once when cached, else the plain text until it is rendered (or for
   * good, if rendering fails). A slow render never overwrites what the target was asked to show since.
   */
  fill(target: HTMLElement, key: string, text: string): void;
}

const DEFAULT_SIZE = 200;

export function createMarkdownCache(options: MarkdownCacheOptions = {}): MarkdownCache {
  const size = options.size ?? DEFAULT_SIZE;
  const entries = new Map<string, { text: string; fragment: DocumentFragment }>();
  /** What each target was last asked to show. */
  const wanted = new WeakMap<HTMLElement, string>();

  const cached = (key: string, text: string): DocumentFragment | null => {
    const hit = entries.get(key);
    return hit?.text === text ? (hit.fragment.cloneNode(true) as DocumentFragment) : null;
  };

  const render = async (key: string, text: string): Promise<DocumentFragment> => {
    const hit = cached(key, text);
    if (hit) return hit;
    const fragment = await renderMarkdown(text);
    options.decorate?.(fragment);
    entries.delete(key);
    entries.set(key, { text, fragment: fragment.cloneNode(true) as DocumentFragment });
    if (entries.size > size) entries.delete(entries.keys().next().value!);
    return fragment;
  };

  return {
    render,
    cached,
    async prerender(key, text) {
      await render(key, text);
    },
    fill(target, key, text) {
      wanted.set(target, text);
      const hit = cached(key, text);
      if (hit) {
        target.replaceChildren(hit);
        return;
      }
      target.textContent = text;
      render(key, text)
        .then((fragment) => {
          if (wanted.get(target) === text) target.replaceChildren(fragment);
        })
        .catch(() => undefined);
    },
  };
}
