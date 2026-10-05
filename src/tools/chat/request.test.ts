import { describe, expect, it } from 'vitest';
import { buildRequest, nodeTokens, type RequestOptions, unparsedPdfs } from './request';
import { activePath, addNode, appendUser, type ChatNode, createThread } from './thread';

const options = (patch: Partial<RequestOptions> = {}): RequestOptions => ({
  model: 'a/model',
  fallbacks: [],
  system: '',
  temperature: null,
  maxTokens: null,
  reasoningEffort: '',
  pdfEngine: 'cloudflare-ai',
  contextLength: null,
  ...patch,
});

const none = (): undefined => undefined;

/** `turns` exchanges of `size` characters each way, then a final question. */
function longPath(turns: number, size: number): ChatNode[] {
  const thread = createThread();
  for (let i = 0; i < turns; i++) {
    const user = appendUser(thread, `${i}:${'q'.repeat(size)}`);
    addNode(thread, user.id, { role: 'assistant', content: 'a'.repeat(size), status: 'done' });
  }
  appendUser(thread, 'Last question?');
  return activePath(thread);
}

describe('buildRequest', () => {
  it('sends the system prompt first, then the path, with the options that are set', () => {
    const thread = createThread();
    const hi = appendUser(thread, 'Hi');
    addNode(thread, hi.id, { role: 'assistant', content: 'Hello!', status: 'done' });
    appendUser(thread, 'And now?');
    const built = buildRequest(
      activePath(thread),
      options({
        system: '  Be brief.  ',
        fallbacks: ['b/backup'],
        temperature: 0.2,
        maxTokens: 300,
        reasoningEffort: 'low',
      }),
      none,
    );
    expect(built.body).toEqual({
      model: 'a/model',
      models: ['b/backup'],
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'And now?' },
      ],
      temperature: 0.2,
      max_tokens: 300,
      reasoning: { effort: 'low' },
    });
    expect(built.trimmed).toBe(0);
    expect(built.completionTokens).toBe(300);
  });

  it('leaves out defaults and failed replies without text', () => {
    const thread = createThread();
    const hi = appendUser(thread, 'Hi');
    const failed = addNode(thread, hi.id, { role: 'assistant', content: '', status: 'error' });
    appendUser(thread, 'Again');
    expect(failed.status).toBe('error');
    const built = buildRequest(activePath(thread), options(), none);
    expect(built.body).toEqual({
      model: 'a/model',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'user', content: 'Again' },
      ],
    });
    expect(built.completionTokens).toBe(4096);
  });

  it('maps attachments to content parts, text first, and adds the PDF parser', () => {
    const thread = createThread();
    appendUser(thread, 'Compare these', [
      { id: 'img', name: 'a.png', type: 'image/png', size: 10, kind: 'image' },
      { id: 'pdf', name: 'b.pdf', type: 'application/pdf', size: 10, kind: 'pdf' },
      { id: 'mp3', name: 'c.mp3', type: 'audio/mpeg', size: 10, kind: 'audio' },
      { id: 'txt', name: 'd.md', type: 'text/markdown', size: 4, kind: 'text', text: '# Hi' },
    ]);
    const data: Record<string, string> = {
      img: 'data:image/png;base64,AAAA',
      pdf: 'data:application/pdf;base64,JVBERi0=',
      mp3: 'data:audio/mpeg;base64,SUQz',
    };
    const built = buildRequest(
      activePath(thread),
      options({ pdfEngine: 'mistral-ocr' }),
      (id) => data[id],
    );
    expect(built.body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Compare these' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          {
            type: 'file',
            file: { filename: 'b.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
          },
          { type: 'input_audio', input_audio: { data: 'SUQz', format: 'mp3' } },
          { type: 'text', text: '<file name="d.md">\n# Hi\n</file>' },
        ],
      },
    ]);
    expect(built.body.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
  });

  it('sends a note for attachments whose bytes are gone, and no parser for a gone PDF', () => {
    const thread = createThread();
    appendUser(thread, '', [
      { id: 'pdf', name: 'b.pdf', type: 'application/pdf', size: 10, kind: 'pdf' },
    ]);
    const built = buildRequest(activePath(thread), options(), none);
    expect(built.body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '[Attachment "b.pdf" (PDF) is no longer available.]' }],
      },
    ]);
    expect(built.body.plugins).toBeUndefined();
  });

  it('after a switch to a text-only model, earlier images go as a note; the new message as it is', () => {
    const thread = createThread();
    const image = { id: 'img', name: 'a.png', type: 'image/png', size: 10, kind: 'image' as const };
    const first = appendUser(thread, 'What is this?', [image]);
    addNode(thread, first.id, { role: 'assistant', content: 'A cat.', status: 'done' });
    appendUser(thread, 'And this?', [{ ...image, id: 'img2' }]);
    const built = buildRequest(
      activePath(thread),
      options({ inputModalities: ['text'] }),
      () => 'data:image/png;base64,AAAA',
    );
    expect(built.body.messages[0]?.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'text', text: '[Image "a.png" not sent: this model cannot read it.]' },
    ]);
    expect(built.body.messages[2]?.content).toEqual([
      { type: 'text', text: 'And this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });
});

describe('context trimming', () => {
  it('drops the oldest turns to fit, keeps the system prompt and the last message', () => {
    const path = longPath(10, 4000); // ~1,000 tokens per message, 21 messages
    const built = buildRequest(
      path,
      options({ system: 'Stay on topic.', contextLength: 8000, maxTokens: 1000 }),
      none,
    );
    const messages = built.body.messages;
    expect(built.trimmed).toBeGreaterThan(0);
    expect(built.trimmed % 2).toBe(0); // whole turns
    expect(messages[0]).toEqual({ role: 'system', content: 'Stay on topic.' });
    expect(messages[1]?.role).toBe('user');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Last question?' });
    expect(messages).toHaveLength(1 + 21 - built.trimmed);
    expect(built.promptTokens).toBeLessThanOrEqual(8000 * 0.95 - 1000);
  });

  it('trims nothing when everything fits or the context is unknown', () => {
    const path = longPath(3, 100);
    expect(buildRequest(path, options({ contextLength: 128_000 }), none).trimmed).toBe(0);
    expect(buildRequest(path, options({ contextLength: null }), none).trimmed).toBe(0);
  });

  it('counts attachments in the approximation', () => {
    const thread = createThread();
    const text = appendUser(thread, 'abcd');
    const withImage = appendUser(thread, 'abcd', [
      { id: 'i', name: 'a.png', type: 'image/png', size: 1, kind: 'image' },
    ]);
    expect(nodeTokens(withImage) - nodeTokens(text)).toBe(1500);
  });
});

describe('limits', () => {
  it('clamps max_tokens to the model’s output cap and to what the context leaves', () => {
    const path = longPath(0, 0);
    const capped = buildRequest(
      path,
      options({ maxTokens: 50_000, maxCompletionTokens: 8000, contextLength: 200_000 }),
      none,
    );
    expect(capped.body.max_tokens).toBe(8000);
    expect(capped.completionTokens).toBe(8000);

    const big = longPath(1, 40_000); // ~10,000 tokens each way
    const room = buildRequest(big, options({ maxTokens: 30_000, contextLength: 32_000 }), none);
    expect(room.tooLong).toBe(false);
    expect(room.promptTokens + room.body.max_tokens!).toBeLessThanOrEqual(32_000);
  });

  it('flags a message that alone does not fit the context window', () => {
    const thread = createThread();
    appendUser(thread, 'x'.repeat(40_000)); // ~10,000 tokens
    const tooLong = buildRequest(activePath(thread), options({ contextLength: 8000 }), none);
    expect(tooLong.tooLong).toBe(true);
    expect(buildRequest(activePath(thread), options({ contextLength: 64_000 }), none).tooLong).toBe(
      false,
    );
    expect(buildRequest(activePath(thread), options(), none).tooLong).toBe(false);
  });
});

describe('PDFs read before', () => {
  const pdf = { id: 'pdf', name: 'b.pdf', type: 'application/pdf', size: 10, kind: 'pdf' as const };

  it('go as the parser’s text, with no upload and no parser', () => {
    const thread = createThread();
    appendUser(thread, 'Total?', [{ ...pdf, parsed: '<file name="b.pdf">\nTotal 12\n</file>' }]);
    const built = buildRequest(
      activePath(thread),
      options(),
      () => 'data:application/pdf;base64,AA',
    );
    expect(built.body.messages[0]?.content).toEqual([
      { type: 'text', text: 'Total?' },
      { type: 'text', text: '<file name="b.pdf">\nTotal 12\n</file>' },
    ]);
    expect(built.body.plugins).toBeUndefined();
    expect(unparsedPdfs(activePath(thread), () => 'data:')).toEqual([]);
  });

  it('are listed while they still need the parser', () => {
    const thread = createThread();
    const node = appendUser(thread, 'Total?', [pdf]);
    expect(unparsedPdfs(activePath(thread), () => 'data:')).toEqual([node.attachments![0]]);
    expect(unparsedPdfs(activePath(thread), none)).toEqual([]);
  });
});

describe('what a model can read', () => {
  const ref = (kind: 'image' | 'audio' | 'pdf', parsed?: string) => ({
    id: kind,
    name: `x.${kind}`,
    type: '',
    size: 1,
    kind,
    ...(parsed ? { parsed } : {}),
  });

  it('turns an earlier PDF into a note for a model that cannot read files natively', () => {
    const thread = createThread();
    const first = appendUser(thread, 'Read', [ref('pdf')]);
    addNode(thread, first.id, { role: 'assistant', content: 'Done.', status: 'done' });
    appendUser(thread, 'Next');
    const built = buildRequest(
      activePath(thread),
      options({ pdfEngine: 'native', inputModalities: ['text'] }),
      () => 'data:application/pdf;base64,AA',
    );
    expect(built.body.messages[0]?.content).toEqual([
      { type: 'text', text: 'Read' },
      { type: 'text', text: '[PDF "x.pdf" not sent: this model cannot read it.]' },
    ]);
    expect(built.body.plugins).toBeUndefined();
  });
});
