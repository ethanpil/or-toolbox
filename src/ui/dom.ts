/**
 * The only way this app builds DOM. There is no UI framework and no HTML
 * strings: `h()` creates elements, text always goes in as text nodes, so
 * untrusted strings (model output, file names) can never become markup.
 *
 * ```ts
 * const button = h('button', { class: 'btn btn-primary', type: 'button', onclick: run }, 'Run');
 * const row = h('div', { class: ['row', wide && 'g-4'], 'data-testid': 'row' }, left, right);
 * const list = h('ul', null, items.map((item) => h('li', null, item.name)));
 * ```
 *
 * Rules, in the order `h()` applies them:
 * 1. Children are appended first, so props such as a `<select>`'s `value`
 *    can refer to them. Arrays are flattened (pass long lists as one array
 *    argument, not spread); `null`, `undefined`, `false` and `''` are
 *    skipped; numbers, including 0, render as text.
 * 2. Props: `type` first, then `min`/`max`/`step`, then everything else, and
 *    `value`/`checked`/`selected` last, so constrained inputs keep their value.
 *    - `class`: a string, or a list whose falsy entries are skipped.
 *    - `style`: an object (camelCase or kebab-case names; `--custom`
 *      properties work) or a string; applied through the CSSOM, which the CSP
 *      allows, unlike a `style=""` attribute.
 *    - `dataset`: `data-*` values by camelCase name.
 *    - Event handlers: a function-valued `onclick`-style prop (any case) is
 *      assigned to the element's handler property. A non-function value for
 *      an `on*` key throws. For several listeners or options, use `on()`.
 *    - URL props (`href`, `src`, `action`, `formAction`, `poster`,
 *      `xlink:href`) accept http(s), mailto, tel, blob, relative and
 *      `#fragment` URLs; `data:` only for an `<img>`'s `src`. Anything else
 *      (`javascript:`, ...) is silently dropped: it is either an attack or a
 *      bug, and dropping it is the safe outcome for both.
 *    - Writable DOM properties are assigned (`disabled`, `textContent`, ...);
 *      everything else (`data-*`, `aria-*`, read-only properties such as
 *      `list` or `form`) is set as an attribute.
 * 3. Never allowed: `innerHTML`, `outerHTML`, `srcdoc`, and creating
 *    `script`, `iframe`, `object` or `embed` elements. These throw.
 */

/** Anything `h()` accepts as a child. (`''` is a string here, and is skipped too.) */
export type Child = Node | string | number | false | null | undefined | readonly Child[];

/** A class string, or a list where falsy entries are skipped. */
export type ClassValue = string | readonly (string | false | null | undefined)[];

/** String-valued CSS properties of CSSStyleDeclaration (camelCase). */
type CssProperty = {
  [K in keyof CSSStyleDeclaration]: CSSStyleDeclaration[K] extends string ? K : never;
}[keyof CSSStyleDeclaration];

/** Inline style: an object of properties (including `--custom` ones) or a CSS text string. */
export type StyleValue =
  string | ({ [K in CssProperty]?: string } & { [custom: `--${string}`]: string | undefined });

/** Handled specially by `h()` or never allowed, so not assignable as plain properties. */
type ReservedKey =
  'class' | 'className' | 'classList' | 'style' | 'dataset' | 'innerHTML' | 'outerHTML' | 'role';

/** Props for an element of type `E`; see the file comment for the rules. */
export type Props<E extends HTMLElement = HTMLElement> = Partial<Omit<E, ReservedKey>> & {
  class?: ClassValue;
  style?: StyleValue;
  dataset?: Record<string, string>;
  role?: string;
} & Record<`data-${string}` | `aria-${string}`, string | number | boolean | null | undefined>;

/** Tags h() refuses to create: they run or embed code. */
const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed']);
/** Props h() refuses (compared in lower case): they parse HTML. */
const FORBIDDEN_PROPS = new Set(['innerhtml', 'outerhtml', 'srcdoc']);
/** Props that hold URLs (compared in lower case). */
const URL_PROPS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'xlink:href']);
const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'blob']);

/** Creates an element. See the file comment for the rules. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props<HTMLElementTagNameMap[K]> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  if (FORBIDDEN_TAGS.has(tag.toLowerCase())) {
    throw new Error(`h(): <${tag}> is not allowed`);
  }
  const el = document.createElement(tag);
  appendChildren(el, children);

  const entries = Object.entries(props ?? {}) as [string, unknown][];
  entries.sort(([a], [b]) => propRank(a) - propRank(b));
  for (const [key, value] of entries) setProp(el, key, value);

  return el;
}

/** Order in which props are applied; see rule 2. */
function propRank(key: string): number {
  if (key === 'type') return 0;
  if (key === 'min' || key === 'max' || key === 'step') return 1;
  if (key === 'value' || key === 'checked' || key === 'selected') return 3;
  return 2;
}

function setProp(el: HTMLElement, key: string, value: unknown): void {
  const lower = key.toLowerCase();

  if (FORBIDDEN_PROPS.has(lower)) {
    throw new Error(`h(): ${key} is not allowed; pass children instead`);
  }
  if (lower.startsWith('on')) {
    setHandler(el, key, value);
    return;
  }
  if (value === null || value === undefined) return;

  if (key === 'class') {
    el.className = classNames(value as ClassValue);
  } else if (key === 'style') {
    setStyle(el, value as StyleValue);
  } else if (key === 'dataset') {
    Object.assign(el.dataset, value);
  } else if (URL_PROPS.has(lower) && !isSafeUrl(value, el.tagName === 'IMG' && lower === 'src')) {
    // Dropped: see rule 2.
  } else if (!key.includes('-') && isWritable(el, key)) {
    (el as unknown as Record<string, unknown>)[key] = value;
  } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    el.setAttribute(key, String(value));
  } else {
    throw new Error(`h(): attribute ${key} needs a string, number or boolean`);
  }
}

function classNames(value: ClassValue): string {
  return typeof value === 'string' ? value : value.filter(Boolean).join(' ');
}

function setHandler(el: HTMLElement, key: string, value: unknown): void {
  if (value === null || value === undefined) return;
  const property = key.toLowerCase();
  if (typeof value !== 'function') {
    throw new Error(`h(): ${key} must be a function (the CSP forbids inline handlers)`);
  }
  if (!(property in el))
    throw new Error(`h(): ${key} is not an event handler of <${el.localName}>`);
  (el as unknown as Record<string, unknown>)[property] = value;
}

function setStyle(el: HTMLElement, style: StyleValue): void {
  if (typeof style === 'string') {
    el.style.cssText = style;
    return;
  }
  for (const [name, value] of Object.entries<string | undefined>(style)) {
    if (value === undefined) continue;
    if (name.includes('-')) el.style.setProperty(name, value);
    else (el.style as unknown as Record<string, string>)[name] = value;
  }
}

/** True if `key` is a property of `el` that can be assigned (a data property or an accessor with a setter). */
function isWritable(el: object, key: string): boolean {
  for (let object: object | null = el; object; object = Reflect.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor) return descriptor.writable === true || descriptor.set !== undefined;
  }
  return false;
}

/**
 * True for http(s), mailto, tel, blob, relative and fragment URLs, and for
 * `data:` when `allowData` is set. Scheme detection follows the URL parser:
 * leading spaces/control characters and embedded tabs/newlines are ignored.
 */
export function isSafeUrl(value: unknown, allowData = false): boolean {
  if (typeof value !== 'string') return false;
  // eslint-disable-next-line no-control-regex -- stripping exactly what URL parsing ignores
  const cleaned = value.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned)?.[1]?.toLowerCase();
  if (scheme === undefined) return true;
  return SAFE_URL_SCHEMES.has(scheme) || (allowData && scheme === 'data');
}

/** Appends children to `parent`; same rules as `h()` (rule 1). */
export function append(parent: Node, ...children: Child[]): void {
  appendChildren(parent, children);
}

/** Iterative, so a huge or deeply nested list cannot overflow the stack. */
function appendChildren(parent: Node, children: readonly Child[]): void {
  const stack: { list: readonly Child[]; next: number }[] = [{ list: children, next: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.next >= top.list.length) {
      stack.pop();
      continue;
    }
    const child = top.list[top.next++];
    if (child === null || child === undefined || child === false || child === '') continue;
    if (isChildList(child)) stack.push({ list: child, next: 0 });
    else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function isChildList(child: Child): child is readonly Child[] {
  return Array.isArray(child);
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
