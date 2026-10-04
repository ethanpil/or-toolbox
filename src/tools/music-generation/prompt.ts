/**
 * The song form as Lyria's prompt. Lyria takes no fields for genre, lyrics, vocals or length
 * (docs/openrouter-api.md §0, §6): everything is prompt text, written plainly, one fact per line, with the
 * lyrics last so their section tags stay intact.
 */
import type { ChatRequest, ContentPart } from '../../core/api/types';

export type Vocals = 'vocals' | 'instrumental';

export interface SongForm {
  /** The free-text description (the tool's main prompt). */
  description: string;
  genre: string;
  mood: string;
  /** Beats per minute ("120") or words ("slow"). */
  tempo: string;
  instruments: string;
  vocals: Vocals;
  /** What the singing should be like ("warm female vocals"). */
  voice: string;
  lyrics: string;
}

export const isVocals = (value: unknown): value is Vocals =>
  value === 'vocals' || value === 'instrumental';

/** "120", "120bpm" → "120 BPM"; words stay as written. */
export function tempoText(tempo: string): string {
  const bpm = /^(\d{2,3})\s*(bpm)?$/i.exec(tempo.trim());
  return bpm ? `${bpm[1]} BPM` : tempo.trim();
}

/** "Label: value." with the value's own trailing punctuation dropped, or nothing when the value is empty. */
function fact(label: string, value: string): string | null {
  const clean = value.trim().replace(/[\s.!?,;:]+$/, '');
  return clean ? `${label}: ${clean}.` : null;
}

/** The prompt text. `withImage` adds a line that points Lyria at the attached reference image. */
export function buildPrompt(form: SongForm, withImage = false): string {
  const instrumental = form.vocals === 'instrumental';
  const description = form.description.trim();
  const lines = [
    description || (instrumental ? 'Compose an instrumental piece.' : 'Compose a song.'),
    fact('Genre', form.genre),
    fact('Mood', form.mood),
    fact('Tempo', tempoText(form.tempo)),
    fact('Instruments', form.instruments),
    instrumental ? 'Instrumental only, no vocals.' : fact('Vocals', form.voice),
    withImage ? 'Let the attached image set the mood.' : null,
  ];
  if (!instrumental && form.lyrics.trim()) lines.push(`Sing these lyrics:\n${form.lyrics.trim()}`);
  return lines.filter((line): line is string => line !== null).join('\n');
}

/** The streamed chat request for one song (Lyria needs audio output and streaming; no `audio` object, §6.2). */
export function songRequest(
  model: string,
  prompt: string,
  imageDataUrl: string | null,
): ChatRequest {
  const content: string | ContentPart[] = imageDataUrl
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ]
    : prompt;
  return { model, messages: [{ role: 'user', content }], modalities: ['text', 'audio'] };
}
