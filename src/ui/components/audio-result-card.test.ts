import { afterEach, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import { getCore } from '../../core/index';
import { formatDuration } from '../format';
import { resultHandle } from '../tool/results';
import type { ResultHandle, SendItem } from '../tool/types';
import { audioResultCard, type AudioResultCardOptions } from './audio-result-card';

const hoisted = vi.hoisted(() => ({
  transcode: vi.fn((_blob: Blob, format: string) =>
    Promise.resolve(new Blob([`converted to ${format}`])),
  ),
  confirm: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../core/media/transcode', () => ({ transcode: hoisted.transcode }));
vi.mock('../feedback/dialogs', () => ({ confirmDialog: hoisted.confirm }));

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, id: string): T | null =>
  root.querySelector<T>(`[data-testid="${id}"]`);

const core = getCore();
/** Every handle the cards registered, with a spy on its `remove`. */
const handles = new Map<ResultHandle, MockInstance>();
const removeSpy = (handle: ResultHandle): MockInstance => handles.get(handle)!;
const sent: SendItem[][] = [];
const ui: AudioResultCardOptions['ui'] = {
  addResult: (input) => {
    const handle = resultHandle(core, core.results.add({ tool: 'text-to-speech', ...input }));
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
  // jsdom has no canvas and no media playback; neither is what is tested here.
  HTMLCanvasElement.prototype.getContext = () => null;
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
  hoisted.transcode.mockClear();
  hoisted.confirm.mockReset();
  hoisted.confirm.mockImplementation(() => Promise.resolve(true));
  document.body.replaceChildren();
});

const mp3 = (): Blob =>
  new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x64])], { type: 'audio/mpeg' });

function card(options: Partial<AudioResultCardOptions> = {}) {
  const onRemove = vi.fn();
  const made = audioResultCard({
    ui,
    blob: mp3(),
    name: 'speech.mp3',
    seconds: 75,
    peaks: new Float32Array(8),
    metaParts: ['1:15', null, 'Alloy', false, '4 B'],
    formats: ['mp3', 'wav'],
    onRemove,
    testId: 'tts',
    ...options,
  });
  return { ...made, onRemove };
}

describe('audioResultCard', () => {
  it('registers the result with the leave guard and shows the file', () => {
    const { element, handle } = card();
    expect(handle.result).toMatchObject({ kind: 'audio', name: 'speech.mp3', downloaded: false });
    expect(core.results.pending()).toContain(handle.result);
    expect(element.querySelector('h3')?.textContent).toBe('speech.mp3');
    expect($(element, 'tts-result-meta')?.textContent).toBe('1:15 · Alloy · 4 B');
    expect($(element, 'tts-player')?.querySelector('audio')?.getAttribute('aria-label')).toBe(
      `speech.mp3, ${formatDuration(75)}`,
    );
  });

  it('takes a title, a heading level and extra content', () => {
    const lyrics = document.createElement('p');
    const { element } = card({ title: 'Variation 2', headingLevel: 4, extra: lyrics });
    expect(element.querySelector('h4')?.textContent).toBe('Variation 2');
    expect(element.contains(lyrics)).toBe(true);
  });

  it('saves the file as it is in its own format, converts it to the others, and marks it downloaded', async () => {
    const { element, handle } = card();
    document.body.append(element);
    expect([...element.querySelectorAll('.dropdown-item')].map((item) => item.textContent)).toEqual(
      ['MP3.mp3', 'WAV.wav'],
    );

    $<HTMLButtonElement>(element, 'export-mp3')!.click();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ name: 'speech.mp3', blob: handle.result.blob });
    expect(hoisted.transcode).not.toHaveBeenCalled();
    expect(handle.result.downloaded).toBe(true);

    $<HTMLButtonElement>(element, 'export-wav')!.click();
    await vi.waitFor(() => expect(saved).toHaveLength(2));
    expect(hoisted.transcode).toHaveBeenCalledWith(handle.result.blob, 'wav');
    expect(saved[1]?.name).toBe('speech.wav');
    expect(await saved[1]?.blob.text()).toBe('converted to wav');
  });

  it('always offers the file itself, e.g. a WebM recording next to its WAV conversion', () => {
    const blob = new Blob(['webm'], { type: 'audio/webm' });
    const both = card({ blob, name: 'recording.webm', formats: ['wav'] });
    expect(
      [...both.element.querySelectorAll('.dropdown-item')].map((item) => item.textContent),
    ).toEqual(['WEBM.webm', 'WAV.wav']);
    const alone = card({ blob, name: 'recording.webm', formats: [] });
    expect($(alone.element, 'tts-download')?.textContent).toBe('Download .webm');
  });

  it('sends the file to another tool', () => {
    const { element, handle } = card();
    $<HTMLButtonElement>(element, 'tts-send')!.click();
    expect(sent).toEqual([[{ kind: 'file', blob: handle.result.blob, name: 'speech.mp3' }]]);
  });

  it('Remove drops the result and hands focus to the next card, the previous one, then the fallback', async () => {
    const fallback = document.createElement('button');
    const list = document.createElement('div');
    document.body.append(fallback, list);
    const [a, b, c] = ['a.mp3', 'b.mp3', 'c.mp3'].map((name) =>
      card({ name, focusFallback: () => fallback }),
    );
    list.append(a!.element, b!.element, c!.element);
    const remove = (item: typeof a) => $<HTMLButtonElement>(item!.element, 'tts-remove')!;

    remove(a).focus();
    remove(a).click();
    await vi.waitFor(() => expect(a!.onRemove).toHaveBeenCalledOnce());
    expect(a!.element.isConnected).toBe(false);
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

  it('asks focusFallback only after onRemove, so removing the last take lands on what onRemove showed', async () => {
    const empty = document.createElement('p');
    empty.tabIndex = -1;
    empty.hidden = true;
    const item = card({
      onRemove: () => {
        empty.hidden = false;
      },
      focusFallback: () => (empty.hidden ? null : empty),
    });
    document.body.append(item.element, empty);
    $<HTMLButtonElement>(item.element, 'tts-remove')!.focus();
    $<HTMLButtonElement>(item.element, 'tts-remove')!.click();
    await vi.waitFor(() => expect(item.element.isConnected).toBe(false));
    expect(document.activeElement).toBe(empty);
  });

  it('asks before removing audio that was not downloaded, by default', async () => {
    hoisted.confirm.mockImplementation(() => Promise.resolve(false));
    const item = card();
    document.body.append(item.element);
    $<HTMLButtonElement>(item.element, 'tts-remove')!.click();
    await vi.waitFor(() => expect(hoisted.confirm).toHaveBeenCalledOnce());
    expect(hoisted.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Remove the audio?', testId: 'tts-remove-confirm' }),
    );
    await Promise.resolve();
    expect(item.element.isConnected).toBe(true);

    // Downloaded: no question.
    item.handle.download();
    $<HTMLButtonElement>(item.element, 'tts-remove')!.click();
    await vi.waitFor(() => expect(item.onRemove).toHaveBeenCalledOnce());
    expect(hoisted.confirm).toHaveBeenCalledOnce();
  });

  it('keeps the card when beforeRemove says no', async () => {
    let answer = false;
    const beforeRemove = vi.fn(() => Promise.resolve(answer));
    const item = card({ beforeRemove });
    document.body.append(item.element);
    $<HTMLButtonElement>(item.element, 'tts-remove')!.click();
    await vi.waitFor(() => expect(beforeRemove).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(item.element.isConnected).toBe(true);
    expect(removeSpy(item.handle)).not.toHaveBeenCalled();
    expect(item.onRemove).not.toHaveBeenCalled();

    answer = true;
    $<HTMLButtonElement>(item.element, 'tts-remove')!.click();
    await vi.waitFor(() => expect(item.onRemove).toHaveBeenCalledOnce());
    expect(item.element.isConnected).toBe(false);
  });

  it('remove() from code drops everything once, without calling onRemove', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const item = card();
    document.body.append(item.element);
    item.remove();
    item.remove();
    expect(item.element.isConnected).toBe(false);
    expect(removeSpy(item.handle)).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:test'); // the player's URL
    expect(item.onRemove).not.toHaveBeenCalled();
  });
});
