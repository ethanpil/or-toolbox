/**
 * Deploy skew: a page that started on an older build asks for one of its lazy
 * chunks after a newer build replaced the site, and the host answers 404 (the
 * service worker serves only files of the build it was made with). Vite then
 * fires `vite:preloadError` on the window. The import still fails for the code
 * that asked (it shows its own error); this offers the way out: a reload into
 * the current build.
 */
import { toast, type ToastHandle } from '../ui/feedback/toast';

let shown: ToastHandle | null = null;

/** Call once per page (production only; the dev server has no skew). */
export function installStaleBuildOffer(): void {
  window.addEventListener('vite:preloadError', () => {
    if (shown?.element.isConnected) return;
    shown = toast({
      variant: 'warning',
      title: 'ORtoolbox was updated',
      message: 'Part of this page could not be loaded. Reload to use the latest version.',
      action: { label: 'Reload', onClick: () => window.location.reload(), testId: 'reload' },
      testId: 'stale-build',
    });
  });
}
