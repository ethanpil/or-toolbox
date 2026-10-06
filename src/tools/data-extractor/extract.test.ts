import { describe, expect, it } from 'vitest';
import { ApiError } from '../../core/errors';
import {
  buildRequest,
  estimateDocumentTokens,
  fallbackMode,
  isUnsupportedStrict,
  outputMode,
  parseAnswer,
  repairRequest,
  responseRefusal,
  systemPrompt,
} from './extract';
import { presetById } from './presets';

const fields = presetById('invoice')!.fields;
const page = {
  pageNumber: 1,
  pageCount: 1,
  imageDataUrl: 'data:image/png;base64,AA',
  text: 'Total 9.02',
};

describe('extraction requests', () => {
  it('picks strict structured outputs, JSON mode or the prompt from the model’s parameters', () => {
    expect(outputMode(['max_tokens', 'structured_outputs', 'response_format'])).toBe('schema');
    expect(outputMode(['response_format'])).toBe('json');
    expect(outputMode([])).toBe('prompt');
  });

  it('sends the strict JSON Schema, routed to endpoints that honour it', () => {
    const body = buildRequest(
      'm/vision',
      fields,
      { fileName: 'receipt-03.png', pages: [page] },
      {
        instructions: 'Amounts in EUR',
        mode: 'schema',
        textHint: true,
      },
    );
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'extraction',
        strict: true,
        schema: { type: 'object', additionalProperties: false },
      },
    });
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.temperature).toBe(0);
    const system = body.messages[0]!.content as string;
    expect(system).toContain(
      '- total (currency amount, required): Amount due or paid, including tax.',
    );
    expect(system).toContain('Extra instructions from the user: Amounts in EUR');
    // The schema itself travels in response_format, not in the prompt.
    expect(system).not.toContain('"additionalProperties"');
    const parts = body.messages[1]!.content as { type: string; text?: string }[];
    expect(parts[0]).toEqual({ type: 'text', text: 'Document: “receipt-03.png”, one page.' });
    expect(parts[1]?.text).toContain('Total 9.02');
    expect(parts[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } });
  });

  it('uses JSON mode with the schema in the prompt, or the prompt alone', () => {
    const json = buildRequest(
      'm',
      fields,
      { fileName: 'a.pdf', pages: [page, { ...page, pageNumber: 2 }] },
      {
        instructions: '',
        mode: 'json',
        textHint: false,
      },
    );
    expect(json.response_format).toEqual({ type: 'json_object' });
    expect(json.provider).toBeUndefined();
    expect(json.messages[0]!.content).toContain('"additionalProperties":false');
    expect(JSON.stringify(json.messages[1])).not.toContain('Total 9.02');
    expect(
      (json.messages[1]!.content as unknown[]).filter(
        (part) => (part as { type: string }).type === 'image_url',
      ),
    ).toHaveLength(2);

    const plain = buildRequest(
      'm',
      fields,
      { fileName: 'a.png', pages: [page] },
      { instructions: '', mode: 'prompt', textHint: false },
    );
    expect(plain.response_format).toBeUndefined();
    expect(systemPrompt(fields, '', 'prompt')).toContain('Answer with the JSON object only');
  });

  it('sends only parameters the model supports when routing requires them all', () => {
    const strict = buildRequest(
      'm',
      fields,
      { fileName: 'a.png', pages: [page] },
      {
        instructions: '',
        mode: 'schema',
        textHint: false,
        supported: ['response_format', 'structured_outputs'],
      },
    );
    expect(strict.provider).toEqual({ require_parameters: true });
    expect(strict).not.toHaveProperty('temperature');
    expect(strict).not.toHaveProperty('max_tokens');
    const full = buildRequest(
      'm',
      fields,
      { fileName: 'a.png', pages: [page] },
      {
        instructions: '',
        mode: 'schema',
        textHint: false,
        supported: ['response_format', 'structured_outputs', 'temperature', 'max_tokens'],
      },
    );
    expect(full).toMatchObject({ temperature: 0, max_tokens: 8192 });
  });

  it('tells the model that a required field it cannot find is null', () => {
    const system = systemPrompt(fields, '', 'schema');
    expect(system).toMatch(/required fields too/i);
    expect(system).toMatch(/use null for anything the document does not show/);
  });

  it('recognises a strict request no provider can serve, and the mode to fall back to', () => {
    expect(
      isUnsupportedStrict(
        new ApiError('No endpoints found that can handle the requested parameters.', 404),
      ),
    ).toBe(true);
    expect(
      isUnsupportedStrict(
        new ApiError('This model does not support response_format json_schema', 400),
      ),
    ).toBe(true);
    expect(isUnsupportedStrict(new ApiError('Not found on OpenRouter.', 404))).toBe(false);
    expect(isUnsupportedStrict(new ApiError('Rate limited', 429))).toBe(false);
    expect(isUnsupportedStrict(new Error('No endpoints found'))).toBe(false);
    expect(fallbackMode(['response_format', 'structured_outputs'])).toBe('json');
    expect(fallbackMode(['structured_outputs'])).toBe('prompt');
  });

  it('asks once more, with the bad answer and the problem, when the answer was not usable', () => {
    const body = buildRequest(
      'm',
      fields,
      { fileName: 'a.png', pages: [page] },
      { instructions: '', mode: 'json', textHint: false },
    );
    const repair = repairRequest(body, 'Sure, here it is', 'That answer was not valid JSON.');
    expect(repair.messages).toHaveLength(4);
    expect(repair.messages[2]).toEqual({ role: 'assistant', content: 'Sure, here it is' });
    expect(repair.messages[3]?.content).toMatch(/^That answer was not valid JSON\. Reply again/);
    expect(repair.response_format).toEqual(body.response_format);
  });
});

describe('parseAnswer', () => {
  it('normalises a good answer', () => {
    const parsed = parseAnswer(
      fields,
      '{"vendor_name":"Shop","invoice_date":"2026-10-03","total":"9.02"}',
    );
    expect(parsed.ok && parsed.result.values['total']).toBe(9.02);
  });

  it('unwraps an answer nested under one key, and refuses what is not usable', () => {
    const nested = parseAnswer(fields, '{"invoice":{"vendor_name":"Shop","total":1}}');
    expect(nested.ok && nested.result.values['vendor_name']).toBe('Shop');
    expect(parseAnswer(fields, '')).toEqual({ ok: false, problem: 'The answer was empty.' });
    expect(parseAnswer(fields, 'no')).toEqual({
      ok: false,
      problem: 'That answer was not valid JSON.',
    });
    expect(parseAnswer(fields, '[1,2]')).toEqual({
      ok: false,
      problem: 'That answer was JSON, but not one object.',
    });
    expect(parseAnswer(fields, '{"x":1}').ok).toBe(false);
  });

  it('estimates what a page costs from the image size and the PDF text hint', () => {
    const base = estimateDocumentTokens(fields, 2, { maxSide: 1600, hintPages: 0 });
    const large = estimateDocumentTokens(fields, 2, { maxSide: 2048, hintPages: 0 });
    const small = estimateDocumentTokens(fields, 2, { maxSide: 1024, hintPages: 0 });
    expect(large.promptTokens).toBeGreaterThan(base.promptTokens);
    expect(small.promptTokens).toBeLessThan(base.promptTokens);
    // 2,413 tokens for a 1,600 px page, as OCR counts it.
    expect(
      base.promptTokens - estimateDocumentTokens(fields, 1, { maxSide: 1600 }).promptTokens,
    ).toBe(2413);
    // Each PDF page whose text goes along adds up to 4,000 characters (about 1,000 tokens).
    const hinted = estimateDocumentTokens(fields, 2, { maxSide: 1600, hintPages: 2 });
    expect(hinted.promptTokens - base.promptTokens).toBe(2000);
  });

  it('never asks for more output than the model can give', () => {
    const settings = { instructions: '', mode: 'json' as const, textHint: false };
    const doc = { fileName: 'a.png', pages: [page] };
    expect(buildRequest('m', fields, doc, settings).max_tokens).toBe(8192);
    expect(
      buildRequest('m', fields, doc, { ...settings, maxCompletionTokens: 2000 }).max_tokens,
    ).toBe(2000);
    expect(
      buildRequest('m', fields, doc, { ...settings, maxCompletionTokens: 64_000 }).max_tokens,
    ).toBe(8192);
  });

  it('finds a refusal in a non-streamed answer', () => {
    const answer = (message: Record<string, unknown>, finish: string | null = 'stop') => ({
      id: 'g',
      model: 'm',
      choices: [
        {
          index: 0,
          finish_reason: finish,
          message: { role: 'assistant' as const, content: null, ...message },
        },
      ],
    });
    expect(responseRefusal(answer({ content: '{"a":1}' }))).toBeNull();
    expect(responseRefusal(answer({ content: null, refusal: 'I cannot help with that.' }))).toBe(
      'I cannot help with that.',
    );
    expect(responseRefusal(answer({ content: '' }, 'content_filter'))).toMatch(/content filter/);
    expect(responseRefusal(answer({ content: '' }, 'error'))).toMatch(/error before answering/);
    // Text with a filter finish is an answer, whatever the reason it stopped.
    expect(responseRefusal(answer({ content: '{"a":1}' }, 'content_filter'))).toBeNull();
  });

  it('estimates more for more pages and tables', () => {
    const one = estimateDocumentTokens(fields, 1);
    const three = estimateDocumentTokens(fields, 3);
    expect(three.promptTokens).toBeGreaterThan(one.promptTokens);
    expect(three.completionTokens).toBeGreaterThan(one.completionTokens);
  });
});
