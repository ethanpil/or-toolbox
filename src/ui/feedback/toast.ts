/**
 * Toasts: short, non-blocking status messages in the bottom-right corner (above a tool's Run bar on narrow
 * screens), with optional actions (Undo, Retry, a link). The text is announced through the page's live regions
 * (danger toasts assertively), so the toast itself is not a live region. A toast with an action stays until used
 * or closed, and Alt+Shift+N (`TOAST_SHORTCUT`, said in its announcement) moves focus to the newest one; focus goes
 * back when it closes. Others fade, and hovering or focusing one pauses its timer (Bootstrap's behaviour).
 *
 * ```ts
 * toast({ message: 'Prompt deleted.', action: { label: 'Undo', onClick: restore } });
 * toast({ message: 'Saved.', variant: 'success' });
 * ```
 */
import { Toast } from '../bootstrap';
import { h } from '../dom';
import { icon } from '../icon';
import { announce } from './announce';

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger';

export interface ToastAction {
  label: string;
  /** Runs, then the toast closes. */
  onClick?: () => void;
  /** Makes the action a link instead (navigates in this tab unless `external`). */
  href?: string;
  external?: boolean;
  testId?: string;
}

export interface ToastOptions {
  message: string;
  /** Bold first line. */
  title?: string;
  variant?: ToastVariant;
  /** One main action, e.g. Undo or Retry. */
  action?: ToastAction;
  /** Further actions after the main one. */
  actions?: ToastAction[];
  /** Auto-hide delay for a toast without actions; default 5 s; 0 keeps it until closed. A toast with an action never auto-hides. */
  timeoutMs?: number;
  testId?: string;
}

export interface ToastHandle {
  readonly element: HTMLElement;
  hide(): void;
}

const VARIANT_ICONS: Record<ToastVariant, string> = {
  info: 'info-circle-fill',
  success: 'check-circle-fill',
  warning: 'exclamation-triangle-fill',
  danger: 'x-octagon-fill',
};

/** More toasts than this and the oldest one leaves. */
const MAX_TOASTS = 4;

let container: HTMLElement | null = null;

/** Reaches the newest toast that has an action (said in its announcement). */
export const TOAST_SHORTCUT = 'Alt+Shift+N';
let shortcutInstalled = false;
/** Where focus was before the shortcut moved it into a toast; it goes back there when that toast closes. */
let returnFocus: HTMLElement | null = null;

/**
 * The container is the last thing on the page, so keyboard users would tab through everything to reach a toast's
 * Undo or Retry: Alt+Shift+N (Option+Shift+N) moves focus to the newest toast with an action instead.
 */
function installShortcut(): void {
  if (shortcutInstalled) return;
  shortcutInstalled = true;
  document.addEventListener('keydown', (event) => {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (event.code !== 'KeyN') return;
    const withActions = [
      ...(container?.querySelectorAll<HTMLElement>('.or-toast:not([data-actions="0"])') ?? []),
    ];
    const target = withActions.at(-1)?.querySelector<HTMLElement>('.btn');
    if (!target) return;
    event.preventDefault();
    const active = document.activeElement;
    if (active instanceof HTMLElement && !container?.contains(active)) returnFocus = active;
    target.focus();
  });
}

function ensureContainer(): HTMLElement {
  installShortcut();
  if (container?.isConnected) return container;
  container = h('section', {
    class: 'toast-container position-fixed end-0 p-3 or-toasts',
    'aria-label': 'Notifications',
    'data-testid': 'toasts',
  });
  document.body.append(container);
  return container;
}

export function toast(options: ToastOptions): ToastHandle {
  const variant = options.variant ?? 'info';
  const actions = [options.action, ...(options.actions ?? [])].filter(
    (action): action is ToastAction => action !== undefined,
  );
  // Safe at any time: a second call, or one after the toast is gone, does nothing.
  let disposed = false;
  const close = (): void => {
    if (!disposed) instance.hide();
  };
  // Each action runs once, however fast it is clicked again.
  let acted = false;
  const act = (action: ToastAction): void => {
    if (acted) return;
    acted = true;
    close();
    action.onClick?.();
  };

  const actionButtons = actions.map((action, index) => {
    const className = ['btn btn-sm', index === 0 ? 'btn-primary' : 'btn-outline-secondary'];
    if (action.href) {
      return h(
        'a',
        {
          class: className,
          href: action.href,
          ...(action.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
          'data-testid': action.testId,
          onclick: (event: MouseEvent) => {
            if (acted) event.preventDefault();
            else act(action);
          },
        },
        action.label,
      );
    }
    return h(
      'button',
      {
        type: 'button',
        class: className,
        'data-testid': action.testId,
        onclick: () => act(action),
      },
      action.label,
    );
  });

  const element = h(
    'div',
    {
      class: 'toast or-toast',
      'data-testid': options.testId ?? 'toast',
      'data-variant': variant,
      'data-actions': String(actions.length),
    },
    h(
      'div',
      { class: 'toast-body d-flex gap-2 align-items-start' },
      icon(VARIANT_ICONS[variant], `text-${variant}-emphasis fs-5 lh-1 mt-1`),
      h(
        'div',
        { class: 'flex-grow-1 min-w-0' },
        options.title && h('div', { class: 'fw-semibold' }, options.title),
        h('div', { class: 'text-break' }, options.message),
        actionButtons.length > 0 &&
          h('div', { class: 'd-flex flex-wrap gap-2 mt-2' }, actionButtons),
      ),
      h('button', {
        type: 'button',
        class: 'btn-close',
        'data-bs-dismiss': 'toast',
        'aria-label': 'Close',
      }),
    ),
  );

  const host = ensureContainer();
  host.append(element);
  // A toast with an action (Undo, Retry, a link) stays until it is used or closed: nobody should have to race a
  // timer to act (WCAG 2.2.1). Plain messages fade after `timeoutMs`.
  const timeout = actions.length > 0 ? 0 : (options.timeoutMs ?? 5000);
  const instance = new Toast(element, { autohide: timeout > 0, delay: timeout });
  // Focus inside a toast that closes goes back to where the shortcut took it from (else it would drop to <body>).
  let hadFocus = false;
  element.addEventListener('hide.bs.toast', () => {
    hadFocus = element.contains(document.activeElement);
  });
  element.addEventListener('hidden.bs.toast', () => {
    disposed = true;
    instance.dispose();
    element.remove();
    if (hadFocus && returnFocus?.isConnected) returnFocus.focus();
    if (hadFocus) returnFocus = null;
  });
  // Keep the stack short: beyond MAX_TOASTS the oldest message without an action goes first.
  const shown = [...host.querySelectorAll<HTMLElement>('.or-toast')];
  if (shown.length > MAX_TOASTS) {
    const oldest = shown.find((node) => node.dataset.actions === '0') ?? shown[0];
    if (oldest && oldest !== element) Toast.getInstance(oldest)?.hide();
  }
  instance.show();
  announce(
    [
      options.title,
      options.message,
      actions.length > 0 ? `Press ${TOAST_SHORTCUT} to reach it.` : null,
    ]
      .filter(Boolean)
      .join('. ')
      .replace(/\.\. /g, '. '),
    { assertive: variant === 'danger' },
  );
  return { element, hide: close };
}
