/**
 * `sanitizeSvg(blob)`: an SVG a model made, made safe to save. A saved SVG opened from disk is a document: its
 * scripts run and its links load. DOMPurify's SVG profile (loaded on first use) keeps the drawing and drops
 * scripts, event handlers, `foreignObject` (HTML inside the picture), and every reference that leaves the file: an
 * `href` that is not `#local` or an inline `data:image/…`, and styles that `@import` or `url()` something
 * outside the file. Returns a standalone `image/svg+xml` file.
 */
import type { DOMPurify } from 'dompurify';

let purifier: Promise<DOMPurify> | undefined;

/** Anything in CSS that loads another file (inline `data:` images and `#fragment` references stay). */
const EXTERNAL_CSS = /@import|url\(\s*['"]?\s*(?!#|data:image\/)/i;
const LOCAL_HREF = /^\s*(#|data:image\/)/i;

function loadPurifier(): Promise<DOMPurify> {
  purifier ??= import('dompurify').then(({ default: createPurify }) => {
    // A private instance: these hooks never reach the Markdown renderer's.
    const purify = createPurify(window);
    purify.addHook('uponSanitizeElement', (node) => {
      if (node instanceof Element && node.localName === 'style') {
        if (EXTERNAL_CSS.test(node.textContent ?? '')) node.textContent = '';
      }
    });
    purify.addHook('afterSanitizeAttributes', (node) => {
      if (!(node instanceof Element)) return;
      for (const attribute of [...node.attributes]) {
        const name = attribute.localName;
        if ((name === 'href' || name === 'src') && !LOCAL_HREF.test(attribute.value)) {
          node.removeAttributeNode(attribute);
        } else if (name === 'style' && EXTERNAL_CSS.test(attribute.value)) {
          node.removeAttributeNode(attribute);
        }
      }
    });
    return purify;
  });
  purifier.catch(() => {
    purifier = undefined;
  });
  return purifier;
}

export async function sanitizeSvg(blob: Blob): Promise<Blob> {
  const purify = await loadPurifier();
  const fragment = purify.sanitize(await blob.text(), {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed'],
    RETURN_DOM_FRAGMENT: true,
  });
  const root = [...fragment.children].find((node) => node.localName === 'svg');
  // XMLSerializer writes the SVG namespace (and xlink's) the file needs to stand alone.
  const text = root
    ? new XMLSerializer().serializeToString(root)
    : '<svg xmlns="http://www.w3.org/2000/svg"/>';
  return new Blob([text], { type: 'image/svg+xml' });
}
