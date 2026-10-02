/**
 * Markdown rendering for model output.
 *
 * Model output is untrusted. It is parsed by marked and then sanitised by
 * DOMPurify, which returns DOM nodes directly, so no HTML string is ever
 * assigned to innerHTML. Both libraries are loaded on first use (architecture
 * rule 8: heavy libraries are lazy).
 */

// Type-only imports: erased at build time, so the libraries stay out of the
// eager bundle.
import type DOMPurify from 'dompurify';
import type * as Marked from 'marked';

interface Libraries {
  marked: typeof Marked;
  purify: typeof DOMPurify;
}

let libraries: Promise<Libraries> | undefined;

function loadLibraries(): Promise<Libraries> {
  libraries ??= Promise.all([import('marked'), import('dompurify')]).then(
    ([marked, { default: purify }]) => {
      // Links in model output open in a new tab and never get a handle on, or
      // a referrer from, this page.
      purify.addHook('afterSanitizeAttributes', (node) => {
        if (node instanceof HTMLAnchorElement && node.hasAttribute('href')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      });
      return { marked, purify };
    },
  );
  return libraries;
}

/**
 * Renders Markdown to sanitised DOM.
 *
 * ```ts
 * output.replaceChildren(await renderMarkdown(text));
 * ```
 *
 * Scripts, event handlers, `javascript:` URLs, forms, embedded frames and
 * inline styles are removed (inline styles would also be blocked by the CSP).
 */
export async function renderMarkdown(markdown: string): Promise<DocumentFragment> {
  const { marked, purify } = await loadLibraries();
  const html = await marked.parse(markdown, { async: true, gfm: true });
  return purify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'],
    FORBID_ATTR: ['style'],
  });
}
