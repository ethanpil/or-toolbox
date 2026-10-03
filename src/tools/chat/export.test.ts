import { describe, expect, it } from 'vitest';
import { toJson, toMarkdown } from './export';
import { addNode, appendUser, createThread, editUser, parseThread, activePath } from './thread';

function thread() {
  const t = createThread({ id: 't', now: 1 });
  t.system = 'Be brief.';
  const q = appendUser(t, 'What is 2+2?', [
    { id: 'i', name: 'sum.png', type: 'image/png', size: 5, kind: 'image' },
  ]);
  addNode(t, q.id, {
    role: 'assistant',
    content: '**4**',
    model: 'a/model',
    servedModel: 'a/model-2026',
    status: 'done',
    createdAt: 3,
    usage: { promptTokens: 9, completionTokens: 2, costUsd: 0.0001, latencyMs: 300 },
  });
  return t;
}

describe('export', () => {
  it('writes the active path as Markdown', () => {
    const t = thread();
    const old = activePath(t)[0]!;
    const edited = editUser(t, old.id, 'What is 3+3?');
    addNode(t, edited.id, { role: 'assistant', content: '6', model: 'b/model', status: 'stopped' });
    expect(toMarkdown(t)).toBe(
      [
        '# What is 2+2?',
        '**System prompt:**\n\nBe brief.',
        '## You',
        'What is 3+3?',
        '_Attachments: sum.png_',
        '## Assistant (b/model)',
        '6',
        '_(stopped)_',
      ].join('\n\n') + '\n',
    );
  });

  it('writes JSON that reads back as the same conversation', () => {
    const t = thread();
    const json = toJson(t);
    expect(json.messages).toEqual([
      {
        role: 'user',
        content: 'What is 2+2?',
        createdAt: expect.any(Number) as number,
        attachments: [{ name: 'sum.png', type: 'image/png', size: 5 }],
      },
      {
        role: 'assistant',
        content: '**4**',
        createdAt: 3,
        model: 'a/model-2026',
        usage: { promptTokens: 9, completionTokens: 2, costUsd: 0.0001, latencyMs: 300 },
      },
    ]);
    const back = parseThread(JSON.parse(JSON.stringify(json)))!;
    expect(activePath(back).map((node) => node.content)).toEqual(['What is 2+2?', '**4**']);
    expect(back.system).toBe('Be brief.');
  });
});
