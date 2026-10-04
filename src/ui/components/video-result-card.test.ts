import { afterEach, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import { getCore } from '../../core/index';
import { resultHandle } from '../tool/results';
import type { ResultHandle, SendItem } from '../tool/types';
import { videoResultCard, type VideoResultCardOptions } from './video-result-card';

const hoisted = vi.hoisted(() => ({ confirm: vi.fn(() => Promise.resolve(true)) }));
vi.mock('../feedback/dialogs', () => ({ confirmDialog: hoisted.confirm }));

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, id: string): T | null =>
  root.querySelector<T>(`[data-testid="${id}"]`);

const core = getCore();
/** Every handle the cards registered, with a spy on its `remove`. */
const handles = new Map<ResultHandle, MockInstance>();
const removeSpy = (handle: ResultHandle): MockInstance => handles.get(handle)!;
const sent: SendItem[][] = [];
const ui: VideoResultCardOptions['ui'] = {
  addResult: (input) => {
    const handle = resultHandle(core, core.results.add({ tool: 'video-studio', ...input }));
    handles.set(handle, vi.spyOn(handle, 'remove'));
    return handle;
  },
  sendTo: (items) => void sent.push(items),
};
const saved: { name: string; blob: Blob }[] = [];

beforeAll(() => {
  let lastBlob: Blob | null = null;
  URL.createObjectURL = (blob) => {
    lastBlob = blob as Blob;
    return 'blob:test';
  };
  URL.revokeObjectURL = () => undefined;
  // jsdom plays no media; pausing is all the player asks of it.
  HTMLMediaElement.prototype.pause = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ name: this.download, blob: lastBlob! });
  });
});
afterEach(() => {
  for (const handle of handles.keys()) handle.remove();
  handles.clear();
  sent.length = 0;
  saved.length = 0;
  hoisted.confirm.mockClear();
  hoisted.confirm.mockImplementation(() => Promise.resolve(true));
  document.body.replaceChildren();
});

const mp4 = (): Blob => new Blob([new Uint8Array([0, 0, 0, 0x20])], { type: 'video/mp4' });

function card(options: Partial<VideoResultCardOptions> = {}) {
  const onRemove = vi.fn();
  const made = videoResultCard({
    ui,
    blob: mp4(),
    name: 'sunrise-joined-1.mp4',
    seconds: 75,
    meta: ['3 clips', null, false, '4 B'],
    onRemove,
    testId: 'joined',
    ...options,
  });
  return { ...made, onRemove };
}

/** What the browser reports once it has read the video's header. */
function loadMetadata(video: HTMLVideoElement, duration: number): void {
  Object.defineProperty(video, 'duration', { configurable: true, value: duration });
  video.dispatchEvent(new Event('loadedmetadata'));
}

describe('videoResultCard', () => {
  it('registers the video with the leave guard and shows it with its known length', () => {
    const { element, handle, player } = card();
    expect(handle.result).toMatchObject({ kind: 'video', name: 'sunrise-joined-1.mp4' });
    expect(core.results.pending()).toContain(handle.result);
    expect(element.querySelector('h3')?.textContent).toBe('sunrise-joined-1.mp4');
    expect($(element, 'joined-result-meta')?.textContent).toBe('1:15 · 3 clips · 4 B');
    expect($(element, 'joined-player')).toBe(player.element);
    expect(player.video.getAttribute('aria-label')).toBe('sunrise-joined-1.mp4, 1:15');
    // A known length is not measured again.
    loadMetadata(player.video, 12);
    expect($(element, 'joined-result-meta')?.textContent).toBe('1:15 · 3 clips · 4 B');
  });

  it('reads the length from its own player when it is not given', () => {
    const { element, player } = card({ seconds: undefined, meta: [] });
    const meta = $(element, 'joined-result-meta')!;
    expect(meta.hidden).toBe(true);
    expect(player.video.getAttribute('aria-label')).toBe('sunrise-joined-1.mp4');
    loadMetadata(player.video, Infinity); // a recording before it is scanned: no length to show
    expect(meta.hidden).toBe(true);
    loadMetadata(player.video, 12.5);
    expect(meta.hidden).toBe(false);
    expect(meta.textContent).toBe('0:12');
    expect(player.video.getAttribute('aria-label')).toBe('sunrise-joined-1.mp4, 0:12');
  });

  it('takes a title, a heading level and extra content', () => {
    const note = document.createElement('p');
    const { element } = card({ title: 'Joined video 2', headingLevel: 4, extra: note });
    expect(element.querySelector('h4')?.textContent).toBe('Joined video 2');
    expect(element.contains(note)).toBe(true);
  });

  it('downloads the file as it is and marks it, and the results it covers, downloaded', async () => {
    const clip = ui.addResult({ kind: 'video', name: 'clip-1.mp4', blob: mp4() });
    const { element, handle } = card({ covers: () => [clip.result.id] });
    document.body.append(element);
    const download = $<HTMLButtonElement>(element, 'joined-download')!;
    expect(download.textContent).toBe('Download .mp4');
    download.click();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ name: 'sunrise-joined-1.mp4', blob: handle.result.blob });
    expect(handle.result.downloaded).toBe(true);
    expect(clip.result.downloaded).toBe(true);
  });

  it('sends the video to another tool', () => {
    const { element, handle } = card();
    $<HTMLButtonElement>(element, 'joined-send')!.click();
    expect(sent).toEqual([
      [{ kind: 'file', blob: handle.result.blob, name: 'sunrise-joined-1.mp4' }],
    ]);
  });

  it('asks before removing a video that was not downloaded, and not once it was', async () => {
    hoisted.confirm.mockImplementation(() => Promise.resolve(false));
    const item = card();
    document.body.append(item.element);
    $<HTMLButtonElement>(item.element, 'joined-remove')!.click();
    await vi.waitFor(() => expect(hoisted.confirm).toHaveBeenCalledOnce());
    expect(hoisted.confirm.mock.calls[0]).toEqual([
      expect.objectContaining({ title: 'Remove the video?', tone: 'danger' }),
    ]);
    await Promise.resolve();
    expect(item.element.isConnected).toBe(true);
    expect(removeSpy(item.handle)).not.toHaveBeenCalled();

    core.results.markDownloaded(item.handle.result.id);
    $<HTMLButtonElement>(item.element, 'joined-remove')!.click();
    await vi.waitFor(() => expect(item.onRemove).toHaveBeenCalledOnce());
    expect(hoisted.confirm).toHaveBeenCalledOnce();
    expect(item.element.isConnected).toBe(false);
  });

  it('beforeRemove replaces the default question', async () => {
    const beforeRemove = vi.fn(() => true);
    const item = card({ beforeRemove });
    document.body.append(item.element);
    $<HTMLButtonElement>(item.element, 'joined-remove')!.click();
    await vi.waitFor(() => expect(item.onRemove).toHaveBeenCalledOnce());
    expect(beforeRemove).toHaveBeenCalledOnce();
    expect(hoisted.confirm).not.toHaveBeenCalled();
  });

  it('Remove hands focus to the next card, the previous one, then the fallback', async () => {
    const fallback = document.createElement('button');
    const list = document.createElement('div');
    document.body.append(fallback, list);
    const [a, b, c] = ['a.mp4', 'b.mp4', 'c.mp4'].map((name) =>
      card({ name, focusFallback: () => fallback, beforeRemove: () => true }),
    );
    list.append(a!.element, b!.element, c!.element);
    const remove = (item: typeof a) => $<HTMLButtonElement>(item!.element, 'joined-remove')!;

    remove(a).focus();
    remove(a).click();
    await vi.waitFor(() => expect(a!.onRemove).toHaveBeenCalledOnce());
    expect(removeSpy(a!.handle)).toHaveBeenCalledOnce();
    expect(core.results.pending()).not.toContain(a!.handle.result);
    expect(document.activeElement).toBe(remove(b));

    remove(c).click();
    await vi.waitFor(() => expect(c!.onRemove).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(remove(b));

    remove(b).click();
    await vi.waitFor(() => expect(b!.onRemove).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(fallback);
  });

  it('asks focusFallback after onRemove, and leaves focus where onRemove put it', async () => {
    const empty = document.createElement('p');
    empty.tabIndex = -1;
    empty.hidden = true;
    const first = card({
      beforeRemove: () => true,
      onRemove: () => {
        empty.hidden = false;
      },
      focusFallback: () => (empty.hidden ? null : empty),
    });
    document.body.append(first.element, empty);
    $<HTMLButtonElement>(first.element, 'joined-remove')!.click();
    await vi.waitFor(() => expect(first.element.isConnected).toBe(false));
    expect(document.activeElement).toBe(empty);

    const elsewhere = document.createElement('button');
    const second = card({
      beforeRemove: () => true,
      onRemove: () => elsewhere.focus(),
      focusFallback: () => empty,
    });
    document.body.append(second.element, elsewhere);
    $<HTMLButtonElement>(second.element, 'joined-remove')!.click();
    await vi.waitFor(() => expect(second.element.isConnected).toBe(false));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('remove() from code drops everything once, without asking or calling onRemove', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const item = card();
    document.body.append(item.element);
    item.remove();
    item.remove();
    expect(item.element.isConnected).toBe(false);
    expect(removeSpy(item.handle)).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:test'); // the player's URL
    expect(hoisted.confirm).not.toHaveBeenCalled();
    expect(item.onRemove).not.toHaveBeenCalled();
  });
});
