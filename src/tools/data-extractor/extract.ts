/**
 * One extraction request: the prompt, the page images, the structured-output mode the model supports, parsing
 * the answer and the one repair request when it was not usable JSON.
 */
import type { ChatRequest, ContentPart } from '../../core/api/types';
import { isRecord } from '../../core/util';
import {
  extractJson,
  type FieldDef,
  normalizeRecord,
  type RecordResult,
  toJsonSchema,
  TYPE_LABELS,
} from './schema';

/**
 * `schema`: `response_format: json_schema` (strict) where the model supports structured outputs; `json`: JSON mode
 * (`json_object`) with the schema in the prompt; `prompt`: the schema in the prompt only.
 */
export type OutputMode = 'schema' | 'json' | 'prompt';

export function outputMode(supportedParameters: readonly string[]): OutputMode {
  if (supportedParameters.includes('structured_outputs')) return 'schema';
  if (supportedParameters.includes('response_format')) return 'json';
  return 'prompt';
}

export interface PageContent {
  pageNumber: number;
  pageCount: number;
  imageDataUrl: string;
  text?: string;
}

/** The longest text layer sent per page, in characters. */
export const TEXT_HINT_CHARS = 4000;
/** Pages sent in one request; longer documents should use "one per page". */
export const MAX_PAGES_PER_REQUEST = 20;

function fieldLines(fields: readonly FieldDef[]): string {
  return fields
    .map((field) => {
      const parts = [
        `- ${field.name} (${TYPE_LABELS[field.type].toLowerCase()}${field.required ? ', required' : ''})`,
      ];
      if (field.description) parts.push(`: ${field.description}`);
      if (field.type === 'enum') parts.push(` One of: ${(field.options ?? []).join(', ')}.`);
      if (field.type === 'table') {
        parts.push(
          ` Each row has: ${(field.columns ?? [])
            .map((column) => `${column.name} (${TYPE_LABELS[column.type].toLowerCase()})`)
            .join(', ')}.`,
        );
      }
      return parts.join('');
    })
    .join('\n');
}

export function systemPrompt(
  fields: readonly FieldDef[],
  instructions: string,
  mode: OutputMode,
): string {
  const lines = [
    'You extract data from business documents. Read the attached page images and answer with one JSON object holding exactly these fields:',
    fieldLines(fields),
    'Rules: use null for anything the document does not show, and never guess. Dates are YYYY-MM-DD. Amounts and numbers are plain JSON numbers without currency symbols or thousands separators. Copy names, numbers and codes exactly as printed. Tables list every row in document order.',
  ];
  if (mode !== 'schema') {
    lines.push(
      `Answer with the JSON object only, no other text. Its JSON Schema:\n${JSON.stringify(toJsonSchema(fields))}`,
    );
  }
  if (instructions.trim()) lines.push(`Extra instructions from the user: ${instructions.trim()}`);
  return lines.join('\n\n');
}

export function buildRequest(
  model: string,
  fields: readonly FieldDef[],
  document: { fileName: string; pages: readonly PageContent[] },
  settings: { instructions: string; mode: OutputMode; textHint: boolean },
): ChatRequest {
  const content: ContentPart[] = [
    {
      type: 'text',
      text: `Document: “${document.fileName}”, ${document.pages.length === 1 ? 'one page' : `${document.pages.length} pages`}.`,
    },
  ];
  for (const page of document.pages) {
    const hint = settings.textHint ? (page.text ?? '').trim().slice(0, TEXT_HINT_CHARS) : '';
    content.push({
      type: 'text',
      text:
        `Page ${page.pageNumber} of ${page.pageCount}.` +
        (hint
          ? ` The PDF's own text for this page (may be incomplete; trust the image):\n${hint}`
          : ''),
    });
    content.push({ type: 'image_url', image_url: { url: page.imageDataUrl } });
  }
  const body: ChatRequest = {
    model,
    messages: [
      { role: 'system', content: systemPrompt(fields, settings.instructions, settings.mode) },
      { role: 'user', content },
    ],
    temperature: 0,
    max_tokens: 8192,
  };
  if (settings.mode === 'schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'extraction', strict: true, schema: toJsonSchema(fields) },
    };
    // Route only to endpoints that honour the schema (docs/openrouter-api.md §2.6).
    body.provider = { require_parameters: true };
  } else if (settings.mode === 'json') {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

/** The follow-up request after an answer that was not usable JSON: same conversation, plus what went wrong. */
export function repairRequest(original: ChatRequest, answer: string, problem: string): ChatRequest {
  return {
    ...original,
    messages: [
      ...original.messages,
      { role: 'assistant', content: answer.slice(0, 20_000) },
      {
        role: 'user',
        content: `${problem} Reply again with only the JSON object, exactly as the instructions describe.`,
      },
    ],
  };
}

export type Parsed = { ok: true; result: RecordResult } | { ok: false; problem: string };

/** Reads an answer: JSON (fenced or not), an object, unwrapped when the model nested it under one key. */
export function parseAnswer(fields: readonly FieldDef[], text: string): Parsed {
  if (!text.trim()) return { ok: false, problem: 'The answer was empty.' };
  const parsed = extractJson(text);
  if (parsed === undefined) return { ok: false, problem: 'That answer was not valid JSON.' };
  if (!isRecord(parsed)) return { ok: false, problem: 'That answer was JSON, but not one object.' };
  const hasFields = (object: Record<string, unknown>): boolean =>
    fields.some((field) => field.name in object);
  const keys = Object.keys(parsed);
  const inner = keys.length === 1 ? parsed[keys[0]!] : undefined;
  const data = !hasFields(parsed) && isRecord(inner) ? inner : parsed;
  if (!hasFields(data)) {
    return {
      ok: false,
      problem: `That object had none of the fields (${fields.map((field) => field.name).join(', ')}).`,
    };
  }
  return { ok: true, result: normalizeRecord(fields, data) };
}

/** Rough tokens for one document: images, the schema prompt, and an answer that grows with tables. */
export function estimateDocumentTokens(
  fields: readonly FieldDef[],
  pages: number,
): { promptTokens: number; completionTokens: number } {
  const tables = fields.filter((field) => field.type === 'table').length;
  return {
    promptTokens: pages * 1600 + 600 + fields.length * 40,
    completionTokens: 300 + fields.length * 30 + tables * 600 * pages,
  };
}
