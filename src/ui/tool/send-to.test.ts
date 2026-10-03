import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel, isolateChannels } from '../../core/testing/state-fakes';
import { acceptedItems, itemMime, receiveItems, sendItems, sendTargets } from './send-to';
import type { SendItem } from './types';

const channel = (name: string): BroadcastChannel =>
  new FakeBroadcastChannel(name) as unknown as BroadcastChannel;

const settle = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

describe('matching items to tools', () => {
  it('works out an item’s MIME type', () => {
    expect(itemMime({ kind: 'text', text: 'x' })).toBe('text/plain');
    expect(itemMime({ kind: 'text', text: '# x', type: 'text/markdown' })).toBe('text/markdown');
    expect(
      itemMime({ kind: 'file', blob: new Blob([], { type: 'image/png' }), name: 'a.png' }),
    ).toBe('image/png');
    expect(itemMime({ kind: 'file', blob: new Blob([]), name: 'talk.mp3' })).toBe('audio/mpeg');
  });

  it('lists the tools that take at least one item, never the sender', () => {
    const text: SendItem[] = [{ kind: 'text', text: 'Hello', type: 'text/markdown' }];
    const targets = sendTargets(text, 'chat').map((tool) => tool.id);
    expect(targets).toContain('text-to-speech');
    expect(targets).toContain('model-arena');
    expect(targets).not.toContain('chat');
    expect(targets).not.toContain('image-editor');

    const image: SendItem[] = [
      { kind: 'file', blob: new Blob([], { type: 'image/png' }), name: 'a.png' },
    ];
    expect(sendTargets(image).map((tool) => tool.id)).toEqual(
      expect.arrayContaining(['image-editor', 'isolated-image', 'ocr']),
    );
  });

  it('filters items by what a tool accepts', () => {
    const items: SendItem[] = [
      { kind: 'text', text: 'Hi' },
      { kind: 'file', blob: new Blob([], { type: 'image/png' }), name: 'a.png' },
    ];
    expect(acceptedItems({ accepts: ['image/*'] }, items)).toHaveLength(1);
    expect(acceptedItems({ accepts: ['text/plain', 'image/png'] }, items)).toHaveLength(2);
  });
});

describe('the handshake', () => {
  beforeEach(() => {
    isolateChannels();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands the items (Blobs included) to the target and resolves on its acknowledgement', async () => {
    let opened = '';
    const blob = new Blob(['png-bytes'], { type: 'image/png' });
    const items: SendItem[] = [
      { kind: 'text', text: 'Transcript', type: 'text/plain' },
      { kind: 'file', blob, name: 'frame.png' },
    ];
    const sent = sendItems('ocr', items, {
      createChannel: channel,
      open: (href) => {
        opened = href;
        return {} as Window;
      },
    });
    const id = new URL(opened, 'http://localhost').searchParams.get('receive');
    expect(opened).toMatch(/\/tools\/ocr\/\?receive=/);
    expect(id).toBeTruthy();

    const received = await receiveItems(id!, { createChannel: channel });
    expect(await sent).toBe(2);
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(items[0]);
    // Browsers structured-clone the Blob itself; the Node test channel cannot clone jsdom's Blob class.
    expect(received[1]).toMatchObject({ kind: 'file', name: 'frame.png' });
  });

  it('ignores messages for another hand-over', async () => {
    let opened = '';
    const sent = sendItems('ocr', [{ kind: 'text', text: 'mine' }], {
      createChannel: channel,
      open: (href) => {
        opened = href;
        return {} as Window;
      },
      timeoutMs: 200,
    });
    const other = receiveItems('someone-else', {
      createChannel: channel,
      timeoutMs: 100,
      retryMs: 20,
    });
    await expect(other).rejects.toThrow(/Nothing arrived/);
    const id = new URL(opened, 'http://localhost').searchParams.get('receive')!;
    await expect(receiveItems(id, { createChannel: channel })).resolves.toEqual([
      { kind: 'text', text: 'mine' },
    ]);
    await expect(sent).resolves.toBe(1);
  });

  it('fails clearly when the browser blocks the new tab', async () => {
    await expect(
      sendItems('ocr', [{ kind: 'text', text: 'x' }], { createChannel: channel, open: () => null }),
    ).rejects.toThrow(/blocked the new tab/);
  });

  it('times out when the target never answers', async () => {
    vi.useFakeTimers();
    const sent = sendItems('ocr', [{ kind: 'text', text: 'x' }], {
      createChannel: channel,
      open: () => ({}) as Window,
      timeoutMs: 1000,
    });
    const assertion = expect(sent).rejects.toThrow(/did not open in time/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it('keeps announcing itself until the items arrive', async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const spy = channel('ortoolbox:send');
    spy.onmessage = (event: MessageEvent) => seen.push(event.data);
    const pending = receiveItems('abc', { createChannel: channel, retryMs: 100, timeoutMs: 1000 });
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(
      seen.filter((m) => (m as { type: string }).type === 'ready').length,
    ).toBeGreaterThanOrEqual(3);
    spy.postMessage({ type: 'items', id: 'abc', items: [{ kind: 'text', text: 'late' }] });
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([{ kind: 'text', text: 'late' }]);
    expect(seen).toContainEqual({ type: 'ack', id: 'abc', count: 1 });
  });
});
