/**
 * What the document tools share about structured answers: how a model is asked for JSON (`outputMode`), what to do
 * when no provider serves a strict schema (`isUnsupportedStrict`, `fallbackMode`), and when a non-streamed answer
 * is a refusal rather than data (`responseRefusal`).
 */
import { ApiError } from '../errors';
import type { ChatResponse } from './types';

/**
 * `schema`: `response_format: json_schema` (strict) where the model supports structured outputs; `json`: JSON mode
 * (`json_object`) with the schema in the prompt; `prompt`: the schema in the prompt only.
 */
export type OutputMode = 'schema' | 'json' | 'prompt';

/** The best mode the model's `supported_parameters` allow. */
export function outputMode(supportedParameters: readonly string[]): OutputMode {
  if (supportedParameters.includes('structured_outputs')) return 'schema';
  if (supportedParameters.includes('response_format')) return 'json';
  return 'prompt';
}

/**
 * A strict structured-output request that no provider can serve: OpenRouter answers 404 "No endpoints found that
 * can handle the requested parameters" (or a 400 naming the response format) when the routing constraint leaves
 * nothing. A batch then carries on in JSON mode instead of failing every item.
 */
export function isUnsupportedStrict(error: unknown): boolean {
  if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 404)) return false;
  return /no endpoints|response_format|json_schema|structured output/i.test(error.message);
}

/** The mode after strict outputs were refused: JSON mode when the model takes `response_format`, else the prompt. */
export function fallbackMode(supportedParameters: readonly string[]): OutputMode {
  return supportedParameters.includes('response_format') ? 'json' : 'prompt';
}

/**
 * Why a non-streamed answer holds no usable data: the model's own refusal (`message.refusal`), or a reply that ended
 * with `finish_reason` `content_filter` or `error` before any content. Null for a normal answer. A refusal is not
 * parsed and never repaired (another request would only pay for the same refusal).
 */
export function responseRefusal(response: ChatResponse): string | null {
  const choice = response.choices[0];
  const refusal = choice?.message['refusal'];
  if (typeof refusal === 'string' && refusal.trim()) return refusal.trim();
  if ((choice?.message.content ?? '').trim()) return null;
  if (choice?.finish_reason === 'content_filter') {
    return 'The provider’s content filter blocked this reply.';
  }
  if (choice?.finish_reason === 'error') return 'The model stopped with an error before answering.';
  return null;
}
