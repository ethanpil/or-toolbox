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
import { ApiError } from '../../core/errors';
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
vi.mock('../../core/media/image', () => ({
  toDataUrl: (file: File) => Promise.resolve(`data:image/png;base64,${file.name}`),
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

/** A streamed Lyria answer: lyrics, then the MP3 as one base64 fragment (`copies` times the fixture). */
function answer(copies = 1) {
  return (
    _body: ChatRequest,
    opts: CallOptions & { onEvent: (event: ChatStreamEvent) => void },
  ) => {
    const data = Buffer.concat(Array.from({ length: copies }, () => SPEECH)).toString('base64');
    opts.onEvent({ type: 'text', text: LYRICS });
    opts.onEvent({ type: 'audio', data });
    const result: ChatStreamResult = {
      id: 'gen-1',
      model: 'google/lyria-3-clip-preview',
      text: LYRICS,
      reasoning: '',
      images: [],
      audioChunks: [data],
      audioTranscript: '',
      finishReason: 'stop',
      usage: { cost: 0.04 },
    };
    return Promise.resolve(result);
  };
}

const $ = (root: ParentNode, testId: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const $$ = (root: ParentNode, testId: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

let t: ToolTestContext | null = null;
beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  trims.calls.length = 0;
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  // jsdom implements neither media playback nor canvas drawing (the waveform).
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLCanvasElement.prototype.getContext = () => null;
});
afterEach(() => {
  t?.cleanup();
  t = null;
});

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
    expect($(cards[0]!, 'music-meta')?.textContent).toMatch(/^0:03 · /);
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
    expect($(t.zones.output, 'music-meta')?.textContent).toMatch(/^0:03 · cut from 0:1[23] · /);
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
});
