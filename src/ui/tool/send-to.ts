/**
 * "Send to…": hands items (text, Blobs) from one tool page to another in a new tab, in memory only.
 *
 * The source opens `tools/<target>/?receive=<id>` and keeps the items. The target, once its tool is set up,
 * announces `ready` on BroadcastChannel `ortoolbox:send` (repeating until answered), the source posts the
 * `items` (structured clone carries Blobs), and the target acknowledges. Nothing touches storage. Either side
 * gives up with a clear error after its timeout.
 */
import { InvalidInputError } from '../../core/errors';
import { tools } from '../../tools/registry';
import type { ToolId, ToolManifest } from '../../tools/types';
import { acceptsFile, fileMime, mimeMatches } from '../components/file-types';
import { toolUrl } from '../shell/links';
import type { SendItem } from './types';

export const SEND_CHANNEL = 'ortoolbox:send';

type Message =
  | { type: 'ready'; id: string }
  | { type: 'items'; id: string; items: SendItem[] }
  | { type: 'ack'; id: string; count: number };

export interface SendDeps {
  createChannel?: (name: string) => BroadcastChannel;
  open?: (href: string) => Window | null;
  timeoutMs?: number;
  /** How often the target repeats `ready`. */
  retryMs?: number;
}

const isMessage = (value: unknown): value is Message =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { id?: unknown }).id === 'string' &&
  ['ready', 'items', 'ack'].includes((value as { type?: unknown }).type as string);

/** The MIME type an item counts as for `accepts`. */
export function itemMime(item: SendItem): string {
  return item.kind === 'text'
    ? (item.type ?? 'text/plain')
    : fileMime({ type: item.blob.type, name: item.name });
}

/** The items `tool` accepts. */
export function acceptedItems(
  tool: Pick<ToolManifest, 'accepts'>,
  items: readonly SendItem[],
): SendItem[] {
  return items.filter((item) =>
    item.kind === 'text'
      ? mimeMatches(itemMime(item), tool.accepts)
      : acceptsFile({ type: item.blob.type, name: item.name }, tool.accepts),
  );
}

/** Tools (other than `exclude`) that accept at least one of the items. */
export function sendTargets(items: readonly SendItem[], exclude?: ToolId): ToolManifest[] {
  return tools.filter((tool) => tool.id !== exclude && acceptedItems(tool, items).length > 0);
}

/**
 * Source side: opens the target tool in a new tab and hands `items` over. Resolves once the target acknowledged;
 * rejects when the tab could not be opened or the target never answered. Call from a click handler (pop-ups).
 */
export function sendItems(target: ToolId, items: SendItem[], deps: SendDeps = {}): Promise<number> {
  const id = crypto.randomUUID();
  const channel = (deps.createChannel ?? ((name) => new BroadcastChannel(name)))(SEND_CHANNEL);
  const opened = (deps.open ?? ((href) => window.open(href, '_blank')))(
    toolUrl(target, { receive: id }),
  );
  if (!opened) {
    channel.close();
    return Promise.reject(
      new InvalidInputError(
        'The browser blocked the new tab. Allow pop-ups for this site and try again.',
      ),
    );
  }
  return new Promise<number>((resolve, reject) => {
    let sent = false;
    const finish = (): void => {
      clearTimeout(timer);
      channel.close();
    };
    const timer = setTimeout(() => {
      finish();
      reject(
        new InvalidInputError(
          'The other tool did not open in time, so nothing was sent. Try again.',
        ),
      );
    }, deps.timeoutMs ?? 30_000);
    channel.onmessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (!isMessage(message) || message.id !== id) return;
      if (message.type === 'ready' && !sent) {
        sent = true;
        channel.postMessage({ type: 'items', id, items } satisfies Message);
      } else if (message.type === 'ack') {
        finish();
        resolve(message.count);
      }
    };
  });
}

/** Target side: announces itself for `id` (from `?receive=`) and resolves with the items once they arrive. */
export function receiveItems(id: string, deps: SendDeps = {}): Promise<SendItem[]> {
  const channel = (deps.createChannel ?? ((name) => new BroadcastChannel(name)))(SEND_CHANNEL);
  return new Promise<SendItem[]>((resolve, reject) => {
    const ready = (): void => channel.postMessage({ type: 'ready', id } satisfies Message);
    const retry = setInterval(ready, deps.retryMs ?? 1000);
    const finish = (): void => {
      clearInterval(retry);
      clearTimeout(timer);
      // Let the acknowledgement leave before closing.
      setTimeout(() => channel.close(), 0);
    };
    const timer = setTimeout(() => {
      finish();
      reject(
        new InvalidInputError('Nothing arrived from the other tab. Send it again from there.'),
      );
    }, deps.timeoutMs ?? 15_000);
    channel.onmessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (!isMessage(message) || message.id !== id || message.type !== 'items') return;
      const items = Array.isArray(message.items) ? message.items : [];
      channel.postMessage({ type: 'ack', id, count: items.length } satisfies Message);
      finish();
      resolve(items);
    };
    ready();
  });
}
