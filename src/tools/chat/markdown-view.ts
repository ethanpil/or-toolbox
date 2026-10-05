/**
 * Markdown for chat replies: the shared render cache (src/ui/components/markdown-cache.ts) with a Copy button added
 * to every code block. A reply that is still arriving streams through the shared `streamMarkdown`
 * (src/ui/components/stream-markdown.ts); chat.ts adds the Copy buttons after each draw.
 *
 * Code-block Copy buttons carry `data-copy-code`; the conversation handles their clicks by delegation, so cloned
 * fragments from the cache work without listeners of their own.
 */
import { createMarkdownCache } from '../../ui/components/markdown-cache';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icon';

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

/** Rendered replies: `fill` draws one, `prerender` renders a finished one ahead of its redraw. */
export const replies = createMarkdownCache({ decorate: addCodeCopyButtons });
