/**
 * One notice per page load when the browser blocks Web Storage (a private window, site data blocked): nothing
 * ORtoolbox saves would survive the page, and the first write would only say so after the user had put in work.
 * The detection is core's (`webStorageBlocked`); a failed write later is `presentError`'s `storage-unavailable`.
 */
import { webStorageBlocked } from '../../core/storage/local';
import { toast } from './toast';

let noticed = false;

export function noticeIfStorageBlocked(blocked: () => boolean = webStorageBlocked): void {
  if (noticed || !blocked()) return;
  noticed = true;
  toast({
    variant: 'warning',
    title: 'This browser blocks saving',
    message:
      'Your settings, keys and history cannot be saved here (a private window, or site data blocked for this site). ORtoolbox still works for this visit. Allow site data for this site and reload to keep your changes.',
    timeoutMs: 0,
    testId: 'storage-notice',
  });
}
