/**
 * The only way this app builds DOM. There is no UI framework and no HTML
 * strings: `h()` creates elements, text always goes in as text nodes, so
 * untrusted strings (model output, file names) can never become markup.
 *
 * ```ts
 * const button = h('button', { class: 'btn btn-primary', type: 'button', onclick: run }, 'Run');
 * const row = h('div', { class: ['row', wide && 'g-4'], 'data-testid': 'row' }, left, right);
 * ```
 */

type Falsy = false | null | undefined;

/** Anything `h()` accepts as a child. Falsy values are skipped, so `cond && node` works. */
export type Child = Node | string | number | Falsy | readonly Child[];

/** A class string, or a list where falsy entries are skipped. */
export type ClassValue = string | readonly (string | Falsy)[];

/** Handled specially by `h()` or never allowed, so not assignable as plain properties. */
type ReservedKey =
  'class' | 'className' | 'classList' | 'style' | 'dataset' | 'innerHTML' | 'outerHTML';

/**
 * Props for an element of type `E`:
 * - `class`: string or list of strings.
 * - `style`: applied through the CSSOM (allowed by the CSP, unlike `style=""`).
 * - `dataset`: `data-*` values by camelCase name.
 * - `data-*` / `aria-*` / `role`: set as attributes.
 * - anything else: assigned as a DOM property (`type`, `href`, `disabled`,
 *   `textContent`, `onclick`, ...).
 */
export type Props<E extends HTMLElement = HTMLElement> = Partial<Omit<E, ReservedKey | 'role'>> & {
  class?: ClassValue;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  role?: string;
} & Record<`data-${string}` | `aria-${string}`, string | number | boolean | null | undefined>;

/** Creates an element. See the file comment for the prop rules. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props<HTMLElementTagNameMap[K]> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {}) as [string, unknown][]) {
    if (value === null || value === undefined) continue;

    if (key === 'innerHTML' || key === 'outerHTML') {
      throw new Error(`h(): ${key} is not allowed; pass children instead`);
    }
    if (key.startsWith('on') && typeof value === 'string') {
      throw new Error(`h(): ${key} must be a function, not a string (CSP forbids inline handlers)`);
    }

    if (key === 'class') {
      el.className = classNames(value as ClassValue);
    } else if (key === 'style') {
      Object.assign(el.style, value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key in el && !key.includes('-')) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      // data-*, aria-*, role, and anything that is not a property of this element.
      el.setAttribute(key, String(value));
    } else {
      throw new Error(`h(): attribute ${key} needs a string, number or boolean`);
    }
  }

  append(el, children);
  return el;
}

/** Appends children to `parent`, flattening arrays and skipping falsy values. */
export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (isChildList(child)) append(parent, ...child);
    else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Removes every child of `el`. */
export function clear(el: Element): void {
  el.replaceChildren();
}

/**
 * Adds an event listener and returns a function that removes it.
 *
 * ```ts
 * const off = on(input, 'input', () => update());
 * off();
 * ```
 */
export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  listener: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void;
export function on(
  target: EventTarget,
  type: string,
  listener: (event: Event) => void,
  options?: AddEventListenerOptions,
): () => void;
export function on(
  target: EventTarget,
  type: string,
  listener: (event: never) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, listener as EventListener, options);
  return () => {
    target.removeEventListener(type, listener as EventListener, options);
  };
}

function classNames(value: ClassValue): string {
  return typeof value === 'string' ? value : value.filter(Boolean).join(' ');
}

function isChildList(child: Child): child is readonly Child[] {
  return Array.isArray(child);
}
