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
 * Bootstrap does not stack modals: open one only after the previous one closed (await `closed`).
 */
import { Modal } from '../bootstrap';
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
  readonly titleElement: HTMLElement;
  hide(): void;
  /** Resolves once the modal is hidden and removed. */
  readonly closed: Promise<void>;
}

const FIELD_SELECTOR =
  'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

export function openModal(options: ModalOptions): ModalHandle {
  const titleId = uid('modal-title');
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const titleElement = h(
    'h2',
    { class: 'modal-title h5 d-flex align-items-center gap-2', id: titleId },
    options.icon && icon(options.icon, `text-${options.tone ?? 'primary'}-emphasis`),
    options.title,
  );
  const body = h('div', { class: 'modal-body' }, options.body);
  const footer =
    options.footer === undefined ? null : h('div', { class: 'modal-footer' }, options.footer);
  const header = h(
    'div',
    { class: ['modal-header', options.hideHeader && 'visually-hidden'] },
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
      'aria-labelledby': titleId,
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
  document.body.append(element);

  const modal = new Modal(element, {
    backdrop: options.staticBackdrop ? 'static' : true,
    keyboard: options.keyboard ?? true,
    focus: true,
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  // Bootstrap ignores hide() while the show transition runs; remember the request instead of losing it.
  let shown = false;
  let hideRequested = false;
  const hide = (): void => {
    if (shown) modal.hide();
    else hideRequested = true;
  };

  element.addEventListener('shown.bs.modal', () => {
    shown = true;
    if (hideRequested) {
      modal.hide();
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
    modal.dispose();
    element.remove();
    if (opener?.isConnected) opener.focus();
    else document.getElementById('main')?.focus();
    resolveClosed();
  });

  modal.show();
  return { element, body, footer, titleElement, hide, closed };
}
