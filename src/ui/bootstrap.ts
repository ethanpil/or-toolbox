/**
 * The Bootstrap JS plugins the site uses, imported one by one from Bootstrap's ES module sources (never the
 * whole bundle). Importing a plugin also registers its data API (`data-bs-toggle="dropdown"` and friends) on the
 * document, so markup built with h() works without any JS wiring. Tooltip, Popover, Carousel, ScrollSpy, Tab,
 * Alert and Button are deliberately left out; add one here only when a page needs it.
 */
import Collapse from 'bootstrap/js/src/collapse.js';
import Dropdown from 'bootstrap/js/src/dropdown.js';
import Modal from 'bootstrap/js/src/modal.js';
import Offcanvas from 'bootstrap/js/src/offcanvas.js';
import Toast from 'bootstrap/js/src/toast.js';
import FocusTrap from 'bootstrap/js/src/util/focustrap.js';
import { onReplaceRemove } from './dom';

export { Collapse, Dropdown, Modal, Offcanvas, Toast };

/** Disposes every Bootstrap instance in a subtree (its data, listeners and Popper), e.g. before it is dropped. */
export function disposeBootstrap(root: Element): void {
  const nodes = [root, ...root.querySelectorAll('*')];
  for (const node of nodes) {
    Dropdown.getInstance(node)?.dispose();
    Collapse.getInstance(node)?.dispose();
    Toast.getInstance(node)?.dispose();
    Offcanvas.getInstance(node)?.dispose();
    Modal.getInstance(node)?.dispose();
  }
}

// Re-rendering with replace() must not leak plugin instances (an open dropdown keeps its Popper otherwise).
onReplaceRemove(disposeBootstrap);

/**
 * After a modal closes over an open offcanvas (a confirmation from the Prompts panel, the palette over the
 * drawer), the offcanvas has lost its focus trap: Bootstrap keeps one trap active at a time and does not give the
 * previous one back. Re-arm it, so Tab stays inside the offcanvas. Bootstrap's own deactivation on close clears
 * this trap too (one event namespace).
 */
export function restoreOffcanvasTrap(): void {
  const open = document.querySelector('.offcanvas.show');
  if (open) new FocusTrap({ trapElement: open, autofocus: false }).activate();
}

/**
 * Shows an offcanvas and, once it closes, returns focus to whatever had it. Bootstrap restores focus only for
 * offcanvases opened through `data-bs-toggle`, and ours are opened from code.
 */
export function showOffcanvas(offcanvas: Offcanvas, element: HTMLElement): void {
  if (element.classList.contains('show')) return;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  element.addEventListener(
    'hidden.bs.offcanvas',
    () => {
      if (opener?.isConnected && !element.contains(opener)) opener.focus();
    },
    { once: true },
  );
  offcanvas.show();
}
