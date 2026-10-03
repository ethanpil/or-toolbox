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

export { Collapse, Dropdown, Modal, Offcanvas, Toast };

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
