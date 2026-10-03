import { toast } from './feedback/toast';

/**
 * Copies text to the clipboard. Uses the async Clipboard API; where that is refused (no permission, insecure
 * context, an old browser) it falls back to a temporary selection and `execCommand('copy')`. Resolves false
 * when neither worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'visually-hidden';
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.append(area);
    area.select();
    let ok: boolean;
    try {
      // Deprecated but still the only synchronous fallback; harmless when unsupported.
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    active?.focus();
    return ok;
  }
}

/** Copies `text` and says so: a success toast with `okMessage`, or a warning when the browser blocked it. */
export async function copyWithToast(text: string, okMessage: string): Promise<boolean> {
  const ok = await copyText(text);
  toast(
    ok
      ? { message: okMessage, variant: 'success' }
      : { message: 'Copying was blocked by the browser.', variant: 'warning' },
  );
  return ok;
}
