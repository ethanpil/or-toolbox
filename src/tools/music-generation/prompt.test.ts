import { describe, expect, it } from 'vitest';
import { buildPrompt, type SongForm, songRequest, tempoText } from './prompt';

const FORM: SongForm = {
  description: 'A hopeful song about walking home at dawn.',
  genre: 'Folk pop',
  mood: 'Warm, hopeful.',
  tempo: '96',
  instruments: 'Acoustic guitar, piano',
  vocals: 'vocals',
  voice: 'warm female vocals',
  lyrics: '[Verse]\nMorning light\n\n[Chorus]\nCarry me home\n',
};

describe('buildPrompt', () => {
  it('writes one fact per line and the lyrics last', () => {
    expect(buildPrompt(FORM)).toBe(
      [
        'A hopeful song about walking home at dawn.',
        'Genre: Folk pop.',
        'Mood: Warm, hopeful.',
        'Tempo: 96 BPM.',
        'Instruments: Acoustic guitar, piano.',
        'Vocals: warm female vocals.',
        'Sing these lyrics:',
        '[Verse]',
        'Morning light',
        '',
        '[Chorus]',
        'Carry me home',
      ].join('\n'),
    );
  });

  it('leaves out empty fields, and the voice and lyrics of an instrumental', () => {
    const instrumental = {
      ...FORM,
      vocals: 'instrumental' as const,
      genre: ' ',
      mood: '',
      instruments: '',
    };
    expect(buildPrompt(instrumental, true)).toBe(
      [
        'A hopeful song about walking home at dawn.',
        'Tempo: 96 BPM.',
        'Instrumental only, no vocals.',
        'Let the attached image set the mood.',
      ].join('\n'),
    );
    const blank: SongForm = {
      ...FORM,
      description: '',
      genre: '',
      mood: '',
      tempo: '',
      instruments: '',
      voice: '',
      lyrics: '',
    };
    expect(buildPrompt(blank)).toBe('Compose a song.');
    expect(buildPrompt({ ...blank, vocals: 'instrumental' })).toBe(
      'Compose an instrumental piece.\nInstrumental only, no vocals.',
    );
  });

  it('reads a tempo as beats per minute only when it is a number', () => {
    expect(tempoText('120')).toBe('120 BPM');
    expect(tempoText(' 85bpm ')).toBe('85 BPM');
    expect(tempoText('slow and swaying')).toBe('slow and swaying');
  });
});

describe('songRequest', () => {
  it('asks for audio output, with the image as a second part when there is one', () => {
    expect(songRequest('google/lyria-3-clip-preview', 'Compose a song.', null)).toEqual({
      model: 'google/lyria-3-clip-preview',
      messages: [{ role: 'user', content: 'Compose a song.' }],
      modalities: ['text', 'audio'],
    });
    expect(songRequest('m', 'p', 'data:image/png;base64,AAAA').messages[0]?.content).toEqual([
      { type: 'text', text: 'p' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });
});
