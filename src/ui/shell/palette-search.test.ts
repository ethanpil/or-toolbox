import { describe, expect, it, vi } from 'vitest';
import { normalize, rank, rankBy, scoreItem, scoreWord } from './palette-search';

describe('normalize', () => {
  it('lower-cases, strips accents and collapses whitespace', () => {
    expect(normalize('  Café   Crème ')).toBe('cafe creme');
  });
});

describe('scoreWord', () => {
  it('ranks exact > prefix > word prefix > substring > in-order characters', () => {
    const exact = scoreWord('chat', 'chat');
    const prefix = scoreWord('cha', 'chat');
    const wordPrefix = scoreWord('gen', 'image generation');
    const substring = scoreWord('mag', 'image generation');
    const fuzzy = scoreWord('imgen', 'image generation');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordPrefix);
    expect(wordPrefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(fuzzy);
    expect(fuzzy).toBeGreaterThan(0);
  });

  it('does not match scattered or missing characters', () => {
    expect(scoreWord('xyz', 'image generation')).toBe(0);
    expect(scoreWord('azk', 'alpha beta gamma delta epsilon zeta theta iota kappa')).toBe(0);
  });

  it('matches in-order characters only when fuzzy matching is allowed', () => {
    expect(scoreWord('imgen', 'image generation', false)).toBe(0);
  });
});

describe('scoreItem and rank', () => {
  const tools = [
    { label: 'Chat', detail: 'Chat with any model', keywords: 'documents text vision' },
    { label: 'Speech-to-text', detail: 'Transcribe recordings', keywords: 'audio stt' },
    { label: 'Text-to-speech', detail: 'Read text aloud', keywords: 'audio tts' },
    { label: 'Image generation', detail: 'Create images from a prompt', keywords: 'images image' },
    {
      label: 'Model arena',
      detail: 'Send one input to several models',
      keywords: 'reasoning text vision',
    },
  ];

  it('needs every query word to match', () => {
    expect(scoreItem('text speech', tools[2]!)).toBeGreaterThan(0);
    expect(scoreItem('text banana', tools[2]!)).toBe(0);
  });

  it('matches everything on an empty query', () => {
    expect(rank(tools, '  ')).toHaveLength(tools.length);
  });

  it('puts label matches before description and keyword matches', () => {
    const ranked = rank(tools, 'text').map((tool) => tool.label);
    expect(ranked.slice(0, 2)).toEqual(['Text-to-speech', 'Speech-to-text']);
    expect(ranked).toContain('Chat'); // keyword
  });

  it('finds tools by capability keywords without fuzzy noise from descriptions', () => {
    expect(rank(tools, 'tts').map((tool) => tool.label)).toEqual(['Text-to-speech']);
  });

  it('keeps the original order for ties', () => {
    const same = [{ label: 'Alpha one' }, { label: 'Alpha two' }];
    expect(rank(same, 'alpha').map((item) => item.label)).toEqual(['Alpha one', 'Alpha two']);
  });
});

describe('rankBy', () => {
  interface Model {
    name: string;
    id: string;
  }
  const catalog: Model[] = [
    { name: 'GPT Luna', id: 'openai/gpt-6-luna' },
    { name: 'Gemini Flash', id: 'google/gemini-3.1-flash' },
    { name: 'Qwen Plus', id: 'qwen/qwen3.8-plus' },
  ];

  it('ranks like rank() does', () => {
    const describe = (model: Model) => ({ label: model.name, detail: model.id });
    const expected = rank(
      catalog.map((model) => ({ ...describe(model), model })),
      'flash',
    ).map((entry) => entry.model);
    expect(rankBy(catalog, 'flash', describe)).toEqual(expected);
    expect(rankBy(catalog, '  ', describe)).toEqual(catalog);
  });

  it('describes and normalises each object once, however many searches follow', () => {
    const describe = vi.fn((model: Model) => ({ label: model.name, detail: model.id }));
    rankBy(catalog, 'gpt', describe);
    rankBy(catalog, 'luna', describe);
    rankBy(catalog.slice(1), 'qwen', describe);
    expect(describe).toHaveBeenCalledTimes(catalog.length);
  });

  it('keeps separate caches for different describe functions', () => {
    const byName = (model: Model) => ({ label: model.name });
    const byId = (model: Model) => ({ label: model.id });
    expect(rankBy(catalog, 'qwen3', byName)).toEqual([]);
    expect(rankBy(catalog, 'qwen3', byId)).toEqual([catalog[2]]);
  });
});
