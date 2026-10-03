/**
 * `openModal()`: the one way the site shows a Bootstrap modal. Builds the markup with h(), shows it, focuses
 * the right element, and on close disposes the plugin, removes the markup and returns focus to whatever had it
 * before (Bootstrap only does that for `data-bs-toggle` triggers).
 *
 * ```ts
 * const modal = openModal({ title: 'Rename', body: form, footer: [cancel, save], initialFocus: input });
 * await modal.closed;
 * ```
 *
 * One modal at a time: a second `openModal()` waits until the first closes (it is queued, not stacked).
 * Dialogs that may be asked for several times at once (budget confirmation, "Add a key", unlock) share one
 * pending dialog themselves.
 */
import { Modal, restoreOffcanvasTrap } from '../bootstrap';
import { type Child, h } from '../dom';
import { icon } from '../icon';
import { uid } from '../id';

export type Tone = 'primary' | 'danger' | 'warning' | 'success' | 'info' | 'secondary';

export interface ModalOptions {
  title: string;
  /** Bootstrap Icons name shown before the title, tinted by `tone`. */
  icon?: string;
  tone?: Tone;
  body: Child;
  /** Usually buttons; omit for no footer. */
  footer?: Child;
  size?: 'sm' | 'lg' | 'xl';
  /** Element to focus once shown; default: the first form field, else the last footer button, else the dialog. */
  initialFocus?: HTMLElement | null;
  /** Clicking the backdrop does not close it (Escape still does unless `keyboard: false`). */
  staticBackdrop?: boolean;
  keyboard?: boolean;
  scrollable?: boolean;
  centered?: boolean;
  /** Extra classes on `.modal-dialog` (e.g. `or-palette-dialog`). */
  dialogClass?: string;
  /** Extra classes on `.modal-content`. */
  contentClass?: string;
  /** Hide the visible header (the title stays as the accessible name). */
  hideHeader?: boolean;
  /**
   * false: no Bootstrap fade, so the dialog (and its focus) is there at once. For dialogs people type into the
   * moment they open (the command palette); Bootstrap otherwise keeps the dialog unfocusable while its backdrop
   * fades in, and early keystrokes land on the page.
   */
  animate?: boolean;
  testId?: string;
}

export interface ModalHandle {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
  readonly footer: HTMLElement | null;
  /** The visible title (not in the document when `hideHeader` is set). */
  readonly titleElement: HTMLElement;
  /** Closes it; a dialog still waiting in the queue is dropped without ever showing. */
  hide(): void;
  /** Resolves once the modal is hidden and removed (or dropped from the queue). */
  readonly closed: Promise<void>;
}

const FIELD_SELECTOR =
  'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

/** The modal on screen, and the ones waiting for it: Bootstrap shows one modal at a time. */
let current: { closed: Promise<void> } | null = null;
const waiting: { start: () => void; drop: () => void }[] = [];

function next(): void {
  current = null;
  const upcoming = waiting.shift();
  upcoming?.start();
}

/** True while a modal is on screen (or about to be). */
export function modalOpen(): boolean {
  return current !== null;
}

/**
 * Builds a modal and shows it, or queues it until the one on screen closes (Bootstrap cannot stack modals, and a
 * second backdrop or focus trap would break the first). The handle is usable at once either way.
 */
export function openModal(options: ModalOptions): ModalHandle {
  const titleId = uid('modal-title');

  const titleElement = h(
    'h2',
    { class: 'modal-title h5 d-flex align-items-center gap-2', id: titleId },
    options.icon && icon(options.icon, `text-${options.tone ?? 'primary'}-emphasis`),
    options.title,
  );
  const body = h('div', { class: 'modal-body' }, options.body);
  const footer =
    options.footer === undefined ? null : h('div', { class: 'modal-footer' }, options.footer);
  // Without a visible header there is no close button either (an invisible focusable button would be a trap for
  // keyboard users); Escape and the dialog's own buttons close it, and aria-label names it.
  const header = options.hideHeader
    ? null
    : h(
        'div',
        { class: 'modal-header' },
        titleElement,
        h('button', {
          type: 'button',
          class: 'btn-close',
          'data-bs-dismiss': 'modal',
          'aria-label': 'Close',
        }),
      );

  const element = h(
    'div',
    {
      class: ['modal', options.animate !== false && 'fade'],
      tabIndex: -1,
      ...(options.hideHeader ? { 'aria-label': options.title } : { 'aria-labelledby': titleId }),
      'aria-hidden': 'true',
      'data-testid': options.testId,
    },
    h(
      'div',
      {
        class: [
          'modal-dialog',
          options.size && `modal-${options.size}`,
          options.scrollable && 'modal-dialog-scrollable',
          options.centered !== false && 'modal-dialog-centered',
          options.dialogClass,
        ],
      },
      h('div', { class: ['modal-content', options.contentClass] }, header, body, footer),
    ),
  );

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  let modal: Modal | null = null;
  let shown = false;
  let hideRequested = false;
  let dropped = false;

  // Bootstrap also ignores its own dismissals (a data-bs-dismiss button, Escape, the backdrop) while the dialog
  // is still opening; remember them so the dialog closes once shown instead of staying open.
  element.addEventListener('click', (event) => {
    if (shown) return;
    const target = event.target instanceof Element ? event.target : null;
    const onBackdrop = target === element && !options.staticBackdrop;
    if (onBackdrop || target?.closest('[data-bs-dismiss="modal"]')) hideRequested = true;
  });
  element.addEventListener('keydown', (event) => {
    if (!shown && event.key === 'Escape' && options.keyboard !== false) hideRequested = true;
  });

  const start = (): void => {
    current = { closed };
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.append(element);
    const instance = new Modal(element, {
      backdrop: options.staticBackdrop ? 'static' : true,
      keyboard: options.keyboard ?? true,
      focus: true,
    });
    modal = instance;
    element.addEventListener('shown.bs.modal', () => {
      shown = true;
      // Bootstrap ignores hide() while the show transition runs; honour a request made meanwhile.
      if (hideRequested) {
        instance.hide();
        return;
      }
      const target =
        options.initialFocus ??
        body.querySelector<HTMLElement>(FIELD_SELECTOR) ??
        footer?.querySelector<HTMLElement>('.btn:last-child') ??
        null;
      target?.focus();
    });
    element.addEventListener('hidden.bs.modal', () => {
      instance.dispose();
      element.remove();
      restoreOffcanvasTrap();
      if (opener?.isConnected && opener !== document.body) opener.focus();
      else if (!document.querySelector('.offcanvas.show')) document.getElementById('main')?.focus();
      resolveClosed();
      next();
    });
    instance.show();
  };

  const entry = {
    start,
    drop: () => {
      dropped = true;
      resolveClosed();
    },
  };

  const hide = (): void => {
    if (dropped) return;
    if (!modal) {
      // Still queued: never show it.
      const index = waiting.indexOf(entry);
      if (index !== -1) waiting.splice(index, 1);
      entry.drop();
      return;
    }
    if (shown) modal.hide();
    else hideRequested = true;
  };

  if (current) waiting.push(entry);
  else start();
  return { element, body, footer, titleElement, hide, closed };
}
