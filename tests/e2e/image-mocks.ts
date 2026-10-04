/**
 * Mocked image models and `/images` answers for the Image generation and Image editor specs. Shapes follow
 * docs/openrouter-api.md §3 and tests/fixtures/openrouter/images-*.json; the pictures are the recorded
 * tests/fixtures/media/generated-image.jpg (1024 x 1024) and edited-image.jpg (the same picture with its
 * circle recoloured by a real edit).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEDIA_FIXTURES_DIR,
  type OpenRouterMock,
  type SequenceResponse,
  sseResponse,
} from '../mock/index.ts';

export const KLEIN = 'black-forest-labs/flux.2-klein-4b';
export const GPT_MINI = 'openai/gpt-image-1-mini';
/** $0.014 per megapixel, as billed in the probe (§3.4). */
export const KLEIN_PER_TOKEN = 0.014 / 4096;

export const GENERATED_JPG = readFileSync(join(MEDIA_FIXTURES_DIR, 'generated-image.jpg'));
export const EDITED_JPG = readFileSync(join(MEDIA_FIXTURES_DIR, 'edited-image.jpg'));
export const GENERATED_PATH = join(MEDIA_FIXTURES_DIR, 'generated-image.jpg');

const imageEntry = (id: string, name: string, pricing: Record<string, string>) => ({
  id,
  name,
  created: 1764030274,
  description: `${name} (mock).`,
  context_length: null,
  architecture: {
    modality: 'text+image->image',
    input_modalities: ['text', 'image'],
    output_modalities: ['image'],
  },
  pricing,
  supported_parameters: [],
});

export const CATALOG = [
  imageEntry(KLEIN, 'Black Forest Labs: FLUX.2 klein 4B', {
    prompt: '0',
    completion: '0',
    image_output: String(KLEIN_PER_TOKEN),
  }),
  imageEntry(GPT_MINI, 'OpenAI: GPT Image 1 Mini', {
    prompt: '0.000002',
    completion: '0.000008',
    image_output: '0.000008',
  }),
];

export const IMAGE_MODELS = [
  {
    id: KLEIN,
    name: 'Black Forest Labs: FLUX.2 klein 4B',
    supported_parameters: {
      aspect_ratio: { type: 'enum', values: ['1:1', '4:3', '3:4', '16:9', '9:16', 'auto'] },
      output_format: { type: 'enum', values: ['png', 'jpeg'] },
      n: { type: 'range', min: 1, max: 1 },
      input_references: { type: 'range', min: 0, max: 4 },
      seed: { type: 'boolean' },
    },
    supports_streaming: false,
  },
  {
    id: GPT_MINI,
    name: 'OpenAI: GPT Image 1 Mini',
    supported_parameters: {
      aspect_ratio: { type: 'enum', values: ['1:1', '3:2', '2:3', 'auto'] },
      quality: { type: 'enum', values: ['auto', 'low', 'medium', 'high'] },
      background: { type: 'enum', values: ['auto', 'transparent', 'opaque'] },
      n: { type: 'range', min: 1, max: 10 },
      input_references: { type: 'range', min: 0, max: 16 },
    },
    supports_streaming: true,
  },
];

/** A buffered `/images` answer with `count` copies of `picture` (JPEG unless `mediaType` says otherwise). */
export function imagesJson(
  picture: Buffer,
  count = 1,
  cost = 0.014,
  mediaType = 'image/jpeg',
): SequenceResponse {
  return {
    body: {
      created: 0,
      data: Array.from({ length: count }, () => ({
        b64_json: picture.toString('base64'),
        media_type: mediaType,
      })),
      usage: { prompt_tokens: 19, completion_tokens: 4096 * count, cost },
    },
    headers: { 'x-generation-id': 'gen-img-1790983685-mockmockmockmockmock' },
  };
}

/** An OpenAI image stream (§3.4): comment lines, one partial image, then the finished one. */
export function imagesStream(partial: Buffer, final: Buffer): SequenceResponse {
  return sseResponse([
    ': ',
    ': ',
    {
      type: 'image_generation.partial_image',
      partial_image_index: 0,
      b64_json: partial.toString('base64'),
    },
    ': ',
    {
      type: 'image_generation.completed',
      b64_json: final.toString('base64'),
      media_type: 'image/jpeg',
      created: 1790983685,
      usage: { prompt_tokens: 16, completion_tokens: 272, total_tokens: 288, cost: 0.003006 },
    },
  ]);
}

export function mockImageCatalog(mock: OpenRouterMock): void {
  mock.json('GET', '/api/v1/models', { data: CATALOG });
  mock.json('GET', '/api/v1/images/models', { data: IMAGE_MODELS });
}

/** Request bodies as the mock recorded them. */
export interface ImagesBody {
  model: string;
  prompt: string;
  n?: number;
  seed?: number;
  aspect_ratio?: string;
  output_format?: string;
  stream?: boolean;
  input_references?: { type: string; image_url: { url: string } }[];
}
