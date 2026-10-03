import { describe, expect, it } from 'vitest';
import {
  buildRequest,
  estimateDocumentTokens,
  outputMode,
  parseAnswer,
  repairRequest,
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

  it('estimates more for more pages and tables', () => {
    const one = estimateDocumentTokens(fields, 1);
    const three = estimateDocumentTokens(fields, 3);
    expect(three.promptTokens).toBeGreaterThan(one.promptTokens);
    expect(three.completionTokens).toBeGreaterThan(one.completionTokens);
  });
});
