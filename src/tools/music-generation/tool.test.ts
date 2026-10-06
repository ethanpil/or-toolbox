import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatRequest,
  ChatStreamEvent,
  ChatStreamResult,
  RawModel,
} from '../../core/api/types';
import { withPartialResult } from '../../core/api/chat-stream';
import { ApiError, NetworkError } from '../../core/errors';
import type * as AudioModule from '../../core/media/audio';
import type * as Dialogs from '../../ui/feedback/dialogs';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { CallOptions } from '../../core/types';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

/** A real MP3 (Kokoro, 3.24 s) stands in for Lyria's song. */
const SPEECH = readFileSync(join(import.meta.dirname, '../../../tests/fixtures/media/speech.mp3'));

const trims = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../core/media/ffmpeg-ops', () => ({
  trimMedia: (...args: unknown[]) => {
    trims.calls.push(args);
    return Promise.resolve(new Blob([SPEECH], { type: 'audio/mpeg' }));
  },
}));
vi.mock('../../core/media/image', async () => {
  const { InvalidInputError } = await import('../../core/errors');
  return {
    toDataUrl: (file: File) =>
      file.name.startsWith('broken')
        ? Promise.reject(new InvalidInputError('This image cannot be decoded.'))
        : Promise.resolve(`data:image/png;base64,${file.name}`),
  };
});
/** Audio too short to be an MP3 stands for audio whose length cannot be read. */
vi.mock('../../core/media/audio', async (original) => {
  const real = await original<typeof AudioModule>();
  return {
    ...real,
    getAudioDuration: (blob: Blob) =>
      blob.size < 64 ? Promise.reject(new Error('unreadable')) : real.getAudioDuration(blob),
  };
});
const dialogs = vi.hoisted(() => ({
  confirm: vi.fn<(options: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
}));
vi.mock('../../ui/feedback/dialogs', async (importOriginal) => ({
  ...(await importOriginal<typeof Dialogs>()),
  confirmDialog: dialogs.confirm,
}));
const announced = vi.hoisted(() => [] as string[]);
vi.mock('../../ui/feedback/announce', () => ({
  announce: (text: string) => announced.push(text),
}));

const lyria = (id: string, description: string): RawModel => ({
  id,
  name: id,
  created: 1,
  description,
  context_length: 1_048_576,
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'audio'] },
  pricing: { prompt: '0', completion: '0' },
});
const CATALOG = [
  lyria('google/lyria-3-clip-preview', '30 second duration clips are priced at $0.04 per clip.'),
  lyria('google/lyria-3-pro-preview', 'Full songs. $0.08 per song.'),
];

const LYRICS = '[0.0:1.5] HELLO WORLD\n[1.6:3.0] HELLO DAY';

type StreamOptions = CallOptions & { onEvent: (event: ChatStreamEvent) => void };

/** A Lyria result: `lyrics`, then the MP3 as one base64 fragment (`copies` times the fixture, or `audio`). */
function lyriaResult(
  options: { copies?: number; lyrics?: string; audio?: Buffer | null } = {},
): ChatStreamResult {
  const { copies = 1, lyrics = LYRICS } = options;
  const audio =
    options.audio === undefined
      ? Buffer.concat(Array.from({ length: copies }, () => SPEECH))
      : options.audio;
  return {
    id: 'gen-1',
    model: 'google/lyria-3-clip-preview',
    text: lyrics,
    reasoning: '',
    images: [],
    audioChunks: audio ? [audio.toString('base64')] : [],
    audioTranscript: '',
    finishReason: 'stop',
    usage: { cost: 0.04 },
  };
}

/** A streamed Lyria answer: lyrics, then the MP3 as one base64 fragment (`copies` times the fixture). */
function answer(copies = 1, lyrics = LYRICS) {
  return (_body: ChatRequest, opts: StreamOptions) => {
    const result = lyriaResult({ copies, lyrics });
    opts.onEvent({ type: 'text', text: lyrics });
    opts.onEvent({ type: 'audio', data: result.audioChunks[0]! });
    return Promise.resolve(result);
  };
}

const musicContext = (
  chatStream?: (body: ChatRequest, opts: StreamOptions) => Promise<ChatStreamResult>,
) =>
  createToolTestContext(getTool('music-generation'), {
    catalog: CATALOG,
    ...(chatStream ? { api: { chatStream } } : {}),
  });

const $ = (root: ParentNode, testId: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const $$ = (root: ParentNode, testId: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

let t: ToolTestContext | null = null;
/** jsdom has no media playback: `pause` records which element it was called on. */
const pause = vi.fn<(this: HTMLMediaElement) => void>();
beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  trims.calls.length = 0;
  announced.length = 0;
  dialogs.confirm.mockReset();
  dialogs.confirm.mockImplementation(() => Promise.resolve(true));
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  // jsdom implements neither media playback nor canvas drawing (the waveform).
  pause.mockClear();
  HTMLMediaElement.prototype.pause = pause;
  HTMLCanvasElement.prototype.getContext = () => null;
});
afterEach(async () => {
  await t?.cleanup();
  t = null;
  vi.useRealTimers();
  document.querySelectorAll('[data-testid="toasts"] > *').forEach((node) => node.remove());
});

/** What the API client throws for a paid request that may have gone through. */
const unknownOutcome = (): ApiError =>
  Object.assign(new ApiError('Provider returned error', 502), { outcomeUnknown: true });

describe('Music generation tool', { timeout: 30_000 }, () => {
  it('round-trips the song form', async () => {
    t = createToolTestContext(getTool('music-generation'), { catalog: CATALOG });
    const tool = await t.mount(setup);
    const state = {
      prompt: 'A song about rain',
      settings: {
        genre: 'Jazz',
        mood: 'Mellow',
        tempo: '80',
        instruments: 'Piano',
        vocals: 'instrumental',
        voice: 'Low male voice',
        lyrics: '[Verse]\nRain',
        targetSeconds: 20,
        variations: 3,
      },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);
    tool.applyState({ ...state, settings: { ...state.settings, targetSeconds: null } });
    expect(tool.getState().settings['targetSeconds']).toBeNull();
    // The prompt preview follows the form; an instrumental leaves the lyrics out.
    expect(($(t.zones.drawer, 'music-prompt-preview') as HTMLTextAreaElement).value).toBe(
      'A song about rain\nGenre: Jazz.\nMood: Mellow.\nTempo: 80 BPM.\nInstruments: Piano.\nInstrumental only, no vocals.',
    );
  });

  it('estimates the flat price times the variations, and switches length through the model binding', async () => {
    t = createToolTestContext(getTool('music-generation'), { catalog: CATALOG });
    const tool = await t.mount(setup);
    expect(t.estimate()).toBeCloseTo(0.04, 6);
    tool.applyState({ prompt: '', settings: { variations: 3 } });
    await t.ctx.ui.refreshEstimate();
    expect(t.estimate()).toBeCloseTo(0.12, 6);

    const song = $(t.zones.input, 'music-length-song') as HTMLInputElement;
    const clip = $(t.zones.input, 'music-length-clip') as HTMLInputElement;
    expect(clip.checked).toBe(true);
    song.checked = true;
    song.dispatchEvent(new Event('change'));
    expect(t.ctx.model().model).toBe('google/lyria-3-pro-preview');
    await t.ctx.ui.refreshEstimate();
    expect(t.estimate()).toBeCloseTo(0.24, 6);
  });

  it('streams two variations side by side, with lyrics, and records them as text', async () => {
    const chatStream = vi.fn(answer());
    t = createToolTestContext(getTool('music-generation'), {
      catalog: CATALOG,
      api: { chatStream },
    });
    const tool = await t.mount(setup);
    tool.applyState({
      prompt: 'A cheerful jingle',
      settings: { lyrics: '[Verse]\nHello world\nHello day', variations: 2 },
    });
    await t.runners[0]!.trigger();

    expect(chatStream).toHaveBeenCalledTimes(2);
    const body = chatStream.mock.calls[0]![0];
    expect(body).toMatchObject({
      model: 'google/lyria-3-clip-preview',
      modalities: ['text', 'audio'],
    });
    expect(body.messages[0]?.content).toBe(
      'A cheerful jingle\nSing these lyrics:\n[Verse]\nHello world\nHello day',
    );

    const cards = $$(t.zones.output, 'music-variation');
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.dataset['status'])).toEqual(['done', 'done']);
    expect($$(t.zones.output, 'music-player')).toHaveLength(2);
    expect($$(cards[0]!, 'music-lyric-line').map((line) => line.textContent)).toEqual([
      'HELLO WORLD',
      'HELLO DAY',
    ]);
    expect($(cards[0]!, 'music-result-meta')?.textContent).toMatch(/^0:03 · /);
    expect(t.core.results.pending().map((result) => result.name)).toEqual([
      expect.stringMatching(/^music-.*-1\.mp3$/),
      expect.stringMatching(/^music-.*-2\.mp3$/),
    ]);
    expect(t.status()).toBe('2 variations ready');
    const [record] = await t.core.history.query({ tool: 'music-generation' });
    expect(record?.status).toBe('ok');
    expect(record?.output).toContain('2 variations ready.');
    expect(record?.output).toContain('Variation 2 (0:03):\nHELLO WORLD\nHELLO DAY');
  });

  it('cuts a song longer than the target, with a fade', async () => {
    const chatStream = vi.fn(answer(4)); // about 13 s
    t = createToolTestContext(getTool('music-generation'), {
      catalog: CATALOG,
      api: { chatStream },
    });
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Short please', settings: { targetSeconds: 5 } });
    await t.runners[0]!.trigger();
    expect(trims.calls).toHaveLength(1);
    expect(trims.calls[0]?.slice(1)).toEqual([
      0,
      5,
      expect.objectContaining({ kind: 'audio', fadeOut: 2, bitrate: 192 }),
    ]);
    expect($(t.zones.output, 'music-result-meta')?.textContent).toMatch(
      /^0:03 · cut from 0:1[23] · /,
    );
  });

  it('keeps the variation that worked when another fails', async () => {
    let calls = 0;
    const ok = answer();
    const chatStream = vi.fn(
      (body: ChatRequest, opts: CallOptions & { onEvent: (event: ChatStreamEvent) => void }) => {
        calls += 1;
        return calls === 2
          ? Promise.reject(new ApiError('Lyria is busy', 503, {}))
          : ok(body, opts);
      },
    );
    t = createToolTestContext(getTool('music-generation'), {
      catalog: CATALOG,
      api: { chatStream },
    });
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Two please', settings: { variations: 2 } });
    await t.runners[0]!.trigger();
    const cards = $$(t.zones.output, 'music-variation');
    expect(cards.map((card) => card.dataset['status']).sort()).toEqual(['done', 'failed']);
    expect($(t.zones.output, 'music-failed')?.textContent).toContain('Lyria is busy');
    expect(t.status()).toBe('1 of 2 variations ready; 1 failed');
  });

  it('refuses to send lyrics with an unclosed bracket, and sends a reference image as a second part', async () => {
    const chatStream = vi.fn(answer());
    t = createToolTestContext(getTool('music-generation'), {
      catalog: CATALOG,
      api: { chatStream },
    });
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'x', settings: { lyrics: '[Verse\nHello' } });
    await t.runners[0]!.trigger();
    expect(chatStream).not.toHaveBeenCalled();
    expect($(t.zones.input, 'music-lyrics')?.getAttribute('aria-invalid')).toBe('true');
    expect($(t.zones.input, 'music-lyrics-error')?.textContent).toBe(
      'Line 1: a square bracket is not closed.',
    );

    tool.applyState({ prompt: 'x', settings: { lyrics: '' } });
    tool.onFiles?.([new File(['png'], 'sunset.png', { type: 'image/png' })]);
    expect($(t.zones.input, 'music-image')?.querySelector('img')?.alt).toBe(
      'Reference image: sunset.png',
    );
    await t.runners[0]!.trigger();
    expect(chatStream.mock.calls[0]![0].messages[0]?.content).toEqual([
      { type: 'text', text: 'x\nLet the attached image set the mood.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,sunset.png' } },
    ]);
  });

  it('inserts section tags where the cursor is', async () => {
    t = createToolTestContext(getTool('music-generation'), { catalog: CATALOG });
    await t.mount(setup);
    const lyrics = $(t.zones.input, 'music-lyrics') as HTMLTextAreaElement;
    lyrics.value = 'Hello';
    lyrics.setSelectionRange(5, 5);
    $(t.zones.input, 'music-tag-chorus')!.click();
    expect(lyrics.value).toBe('Hello\n\n[Chorus]\n');
    expect(lyrics.selectionStart).toBe(lyrics.value.length);
    $(t.zones.input, 'music-tag-chorus')!.click();
    expect($(t.zones.input, 'music-lyrics-warnings')?.textContent).toContain(
      '[Chorus] has no lyrics',
    );
  });

  it('puts a tag before selected lyrics, keeps them selected and says what it did', async () => {
    t = musicContext();
    await t.mount(setup);
    const lyrics = $(t.zones.input, 'music-lyrics') as HTMLTextAreaElement;
    lyrics.value = 'Hello world\nSing along';
    lyrics.setSelectionRange(12, 22);
    const intro = $(t.zones.input, 'music-tag-intro')!;
    expect(intro.getAttribute('aria-label')).toBe('Insert an Intro tag');
    expect($(t.zones.input, 'music-tag-verse')?.getAttribute('aria-label')).toBe(
      'Insert a Verse tag',
    );
    intro.click();
    expect(lyrics.value).toBe('Hello world\n\n[Intro]\nSing along');
    expect(lyrics.value.slice(lyrics.selectionStart, lyrics.selectionEnd)).toBe('Sing along');
    expect(document.activeElement).toBe(lyrics);
    expect(announced).toContain('Inserted the [Intro] tag.');
  });

  it('keeps a song whose audio arrived before the stream broke', async () => {
    const chatStream = vi.fn((_body: ChatRequest, opts: StreamOptions) => {
      const result = lyriaResult();
      opts.onEvent({ type: 'audio', data: result.audioChunks[0]! });
      return Promise.reject(
        withPartialResult(new NetworkError('The connection dropped.'), { ...result, usage: null }),
      );
    });
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'A jingle', settings: {} });
    await t.runners[0]!.trigger();
    const card = $(t.zones.output, 'music-variation')!;
    expect(card.dataset['status']).toBe('done');
    expect($(card, 'music-player')).not.toBeNull();
    expect($(card, 'music-note')?.textContent).toBe(
      'The connection ended after the song arrived (The connection dropped.); it is kept.',
    );
    const [record] = await t.core.history.query({ tool: 'music-generation' });
    expect(record?.status).toBe('ok');
  });

  it('still fails when the stream broke before any audio', async () => {
    const chatStream = vi.fn(() =>
      Promise.reject(
        withPartialResult(new NetworkError('The connection dropped.'), {
          ...lyriaResult({ audio: null }),
          usage: null,
        }),
      ),
    );
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'A jingle', settings: {} });
    await t.runners[0]!.trigger();
    expect($(t.zones.output, 'music-variation')?.dataset['status']).toBe('failed');
    expect($(t.zones.output, 'music-retry')).not.toBeNull();
  });

  it('stops at an image that cannot be read: nothing sent, no cards left waiting', async () => {
    const chatStream = vi.fn(answer());
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'x', settings: {} });
    tool.onFiles?.([new File(['png'], 'broken.png', { type: 'image/png' })]);
    await t.runners[0]!.trigger();
    expect(chatStream).not.toHaveBeenCalled();
    expect($$(t.zones.output, 'music-variation')).toHaveLength(0);
    expect($(t.zones.output, 'music-empty')?.hidden).toBe(false);
    expect(t.status()).toBe('The reference image could not be read.');
    expect(await t.core.history.query({ tool: 'music-generation' })).toHaveLength(0);
  });

  it('retries a failed variation on its own, in its card; Remove keeps focus nearby', async () => {
    let calls = 0;
    const ok = answer();
    const chatStream = vi.fn((body: ChatRequest, opts: StreamOptions) => {
      calls += 1;
      return calls === 2 ? Promise.reject(new ApiError('Lyria is busy', 503, {})) : ok(body, opts);
    });
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Two please', settings: { variations: 2 } });
    await t.runners[0]!.trigger();
    const failed = $$(t.zones.output, 'music-variation').find(
      (card) => card.dataset['status'] === 'failed',
    )!;
    const retry = $(failed, 'music-retry')!;
    expect(retry.getAttribute('aria-disabled')).toBe('false');
    retry.click();
    await vi.waitFor(() => expect(failed.dataset['status']).toBe('done'));
    expect(chatStream).toHaveBeenCalledTimes(3);
    expect(chatStream.mock.calls[2]![0].messages[0]?.content).toBe(
      chatStream.mock.calls[0]![0].messages[0]?.content,
    );
    const [record] = await t.core.history.query({ tool: 'music-generation' });
    expect(record).toMatchObject({ title: 'Retry: variation 2', prompt: '', status: 'ok' });
    expect(t.status()).toBe('Variation 2 ready');

    // Removing a card moves focus to its neighbour, and the last one to the empty state. (Downloaded first: an
    // undownloaded song asks before it goes.)
    for (const result of t.core.results.pending()) t.core.results.markDownloaded(result.id);
    const cards = $$(t.zones.output, 'music-variation');
    $(cards[0]!, 'music-remove')!.click();
    await vi.waitFor(() => expect(document.activeElement).toBe($(cards[1]!, 'music-remove')));
    $(cards[1]!, 'music-remove')!.click();
    await vi.waitFor(() => expect(document.activeElement).toBe($(t!.zones.output, 'music-empty')));
    expect(t.core.results.pending()).toHaveLength(0);
  });

  it('shows what Lyria said when it answers with words and no music, and offers no paid retry', async () => {
    const chatStream = vi.fn(() =>
      Promise.resolve(
        lyriaResult({ audio: null, lyrics: 'I cannot create music based on that request.' }),
      ),
    );
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Something odd', settings: {} });
    await t.runners[0]!.trigger();
    expect($(t.zones.output, 'music-failed')?.textContent).toBe(
      'Lyria answered without music: “I cannot create music based on that request.”',
    );
    expect($(t.zones.output, 'music-retry')).toBeNull();
    expect($(t.zones.output, 'music-remove')).not.toBeNull();
  });

  it('never lets the timer overwrite the final status', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      t = musicContext(vi.fn(answer()));
      const tool = await t.mount(setup);
      tool.applyState({ prompt: 'Tick tock', settings: {} });
      const ctx = t.ctx;
      const beginRun = Reflect.get(ctx, 'beginRun');
      vi.spyOn(t.ctx, 'beginRun').mockImplementation(async (...args) => {
        const handle = await beginRun(...args);
        return new Proxy(handle, {
          get(target, prop) {
            if (prop === 'finish') {
              return (result: Parameters<typeof handle.finish>[0]) => {
                vi.advanceTimersByTime(3000); // the History write takes a while
                return target.finish(result);
              };
            }
            const value: unknown = Reflect.get(target, prop, target);
            return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
          },
        });
      });
      await t.runners[0]!.trigger();
      expect(t.status()).toBe('1 variation ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the drawer at an invalid target length and focuses it', async () => {
    const chatStream = vi.fn(answer());
    t = musicContext(chatStream);
    await t.mount(setup);
    const openDrawer = vi.spyOn(t.ctx.ui, 'openDrawer');
    const target = $(t.zones.drawer, 'music-target') as HTMLInputElement;
    target.value = '3';
    target.dispatchEvent(new Event('change'));
    await t.runners[0]!.trigger();
    expect(chatStream).not.toHaveBeenCalled();
    expect(openDrawer).toHaveBeenCalled();
    expect(document.activeElement).toBe(target);
  });

  it('drops lyrics after the cut, and says when a song was shorter than the target', async () => {
    const chatStream = vi.fn(answer(4, '[0.0:2.0] ONE\n[2.0:4.0] TWO\n[6.0:8.0] THREE'));
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Cut me', settings: { targetSeconds: 5 } });
    await t.runners[0]!.trigger();
    const card = $(t.zones.output, 'music-variation')!;
    expect($$(card, 'music-lyric-line').map((line) => line.textContent)).toEqual(['ONE', 'TWO']);
    expect($(card, 'music-note')?.textContent).toBe(
      'Lyrics after 0:05 are not in this audio (1 line).',
    );
    expect($(t.zones.output, 'music-group')?.textContent).toContain('target 0:05');
    expect($(t.zones.output, 'music-group')?.textContent).not.toContain('cut to');
    const [record] = await t.core.history.query({ tool: 'music-generation' });
    expect(record?.output).toContain('ONE\nTWO');
    expect(record?.output).not.toContain('THREE');

    // A song shorter than the target is not cut, and says so.
    tool.applyState({ prompt: 'Short', settings: { targetSeconds: 10 } });
    chatStream.mockImplementation(answer(1));
    await t.runners[0]!.trigger();
    const newest = $(t.zones.output, 'music-variation')!;
    expect(trims.calls).toHaveLength(1);
    expect($(newest, 'music-result-meta')?.textContent).not.toContain('cut from');
    expect($(newest, 'music-note')?.textContent).toBe('Shorter than the 0:10 target: kept whole.');
  });

  it('never shows 0:00 for a song whose length cannot be read', async () => {
    const chatStream = vi.fn(() =>
      Promise.resolve(lyriaResult({ audio: Buffer.from([0xff, 0xfb, 0x90, 0xc4]) })),
    );
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Odd', settings: { targetSeconds: 10 } });
    await t.runners[0]!.trigger();
    const card = $(t.zones.output, 'music-variation')!;
    expect($(card, 'music-result-meta')?.textContent).toMatch(/^Length unknown · /);
    expect(card.textContent).not.toContain('0:00');
    expect($(card, 'music-note')?.textContent).toBe(
      'Its length could not be read, so it was not cut.',
    );
    expect(trims.calls).toHaveLength(0);
  });

  it('shows at most two variations side by side, and one playing pauses the others', async () => {
    t = musicContext(vi.fn(answer()));
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Three', settings: { variations: 3 } });
    await t.runners[0]!.trigger();
    const row = $(t.zones.output, 'music-variation')!.parentElement!;
    expect(row.className).toContain('row-cols-xl-2');
    expect(row.className).not.toMatch(/row-cols-\w+-3/);
    const audios = $$(t.zones.output, 'music-player').map(
      (player) => player.querySelector('audio') ?? (player as unknown as HTMLAudioElement),
    );
    pause.mockClear();
    audios[0]!.dispatchEvent(new Event('play'));
    expect(pause.mock.contexts).toEqual(expect.arrayContaining([audios[1], audios[2]]));
    expect(pause.mock.contexts).not.toContain(audios[0]);
  });

  it('M1: a song that may have been billed says so and asks before it is composed again', async () => {
    let calls = 0;
    const ok = answer();
    const chatStream = vi.fn((body: ChatRequest, opts: StreamOptions) => {
      calls += 1;
      return calls === 2 ? Promise.reject(unknownOutcome()) : ok(body, opts);
    });
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Two please', settings: { variations: 2 } });
    await t.runners[0]!.trigger();
    const failed = $$(t.zones.output, 'music-variation').find(
      (card) => card.dataset['status'] === 'failed',
    )!;
    expect($(failed, 'music-failed')?.textContent).toContain('check your OpenRouter activity');
    expect($(failed, 'music-failed-activity')).not.toBeNull();

    dialogs.confirm.mockImplementation(() => Promise.resolve(false));
    $(failed, 'music-retry')!.click();
    await vi.waitFor(() => expect(dialogs.confirm).toHaveBeenCalledTimes(1));
    expect(dialogs.confirm.mock.calls[0]![0]).toMatchObject({ title: 'Retry anyway?' });
    expect(chatStream).toHaveBeenCalledTimes(2);

    dialogs.confirm.mockImplementation(() => Promise.resolve(true));
    $(failed, 'music-retry')!.click();
    await vi.waitFor(() => expect(failed.dataset['status']).toBe('done'));
    expect(chatStream).toHaveBeenCalledTimes(3);
  });

  it('M1: an answer without any audio was billed: it says so and offers no Retry', async () => {
    const chatStream = vi.fn(() => Promise.resolve(lyriaResult({ audio: null, lyrics: '' })));
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Something odd', settings: {} });
    await t.runners[0]!.trigger();
    expect($(t.zones.output, 'music-failed')?.textContent).toContain('That answer was billed');
    expect($(t.zones.output, 'music-retry')).toBeNull();
    expect(chatStream).toHaveBeenCalledTimes(1);
  });

  it('M2: the error toast’s Retry composes only the variations without an answer', async () => {
    let calls = 0;
    const ok = answer();
    const chatStream = vi.fn((body: ChatRequest, opts: StreamOptions) => {
      calls += 1;
      // The second request hits a fatal error while the first and third go through.
      return calls === 2
        ? Promise.reject(new ApiError('Not enough credits', 402, {}))
        : ok(body, opts);
    });
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Three please', settings: { variations: 3 } });
    await t.runners[0]!.trigger();
    expect(chatStream).toHaveBeenCalledTimes(3);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="toast-retry"]')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('[data-testid="toast-retry"]')!.click();
    await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    const statuses = $$(t.zones.output, 'music-variation').map((card) => card.dataset['status']);
    expect(statuses).toEqual(['done', 'done', 'done']);
    const [record] = await t.core.history.query({ tool: 'music-generation' });
    expect(record).toMatchObject({ title: 'Retry: variation 2', prompt: '', status: 'ok' });
  });

  it('an empty form is not sent: Lyria would make something up and bill it', async () => {
    const chatStream = vi.fn(answer());
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: {} });
    await t.runners[0]!.trigger();
    expect(chatStream).not.toHaveBeenCalled();
    expect(t.status()).toBe('Describe the music first: add a description, a style or lyrics.');
    expect(await t.core.history.query({ tool: 'music-generation' })).toHaveLength(0);
    // Any one field is enough.
    tool.applyState({ prompt: '', settings: { genre: 'Folk pop' } });
    await t.runners[0]!.trigger();
    expect(chatStream).toHaveBeenCalledTimes(1);
  });

  it('warns where the length is chosen when the target is longer than the song Lyria makes', async () => {
    t = musicContext();
    const tool = await t.mount(setup);
    const warning = () => $(t!.zones.input, 'music-length-warning')!;
    tool.applyState({ prompt: 'x', settings: { targetSeconds: 20 } });
    expect(warning().hidden).toBe(true);
    // The default model is Clip: about 30 seconds.
    tool.applyState({ prompt: 'x', settings: { targetSeconds: 120 } });
    expect(warning().hidden).toBe(false);
    expect(warning().textContent).toBe(
      'A Clip makes about 30 seconds, so a target of 120 seconds probably cuts nothing.',
    );
    tool.applyState({ prompt: 'x', settings: { targetSeconds: null } });
    expect(warning().hidden).toBe(true);
  });

  it('names the files by local time, the same clock as the heading above the cards', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 3, 23, 30, 5) });
    const chatStream = vi.fn(answer());
    t = musicContext(chatStream);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'A jingle', settings: {} });
    await t.runners[0]!.trigger();
    expect($(t.zones.output, 'music-result')?.textContent).toContain('music-2026-10-03-233005.mp3');
  });
});
