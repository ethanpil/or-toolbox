import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptionResult } from '../../core/api/types';
import { transcriptEditor } from './editor';
import { mergeParts, type PartInput } from './transcript';

const part = (index: number, texts: [number, string, string?][]): PartInput => ({
  index,
  offset: index * 60,
  duration: 60,
  result: {
    text: '',
    language: 'en',
    duration: 60,
    segments: texts.map(([start, text, speaker]) => ({
      start,
      end: start + 5,
      text,
      ...(speaker === undefined ? {} : { speaker }),
    })),
    words: [],
    usage: null,
  } satisfies TranscriptionResult,
});

const boxes = (root: ParentNode): HTMLTextAreaElement[] => [
  ...root.querySelectorAll<HTMLTextAreaElement>('[data-testid="stt-segment-text"]'),
];

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function mount() {
  const onChange = vi.fn();
  const editor = transcriptEditor({ onSeek: vi.fn(), onChange });
  document.body.append(editor.element);
  cleanup = () => editor.element.remove();
  return { editor, onChange };
}

describe('transcript editor', () => {
  it('adds arriving parts in place: the focused box keeps its text, caret, selection and composition', () => {
    const { editor } = mount();
    const first = [
      part(0, [
        [0, 'Hello there.', '0'],
        [10, 'Second line.', '1'],
      ]),
    ];
    editor.set(mergeParts(first, { partCount: 3 }));
    const box = boxes(editor.element)[1]!;
    box.focus();
    box.value = 'Second line, edited';
    box.dispatchEvent(new Event('input'));
    box.setSelectionRange(3, 9);
    box.dispatchEvent(new CompositionEvent('compositionstart'));

    // Parts 3 and 2 arrive (out of order), each redrawing the transcript.
    editor.set(mergeParts([...first, part(2, [[0, 'Third part.', '0']])], { partCount: 3 }));
    const all = [...first, part(1, [[0, 'Middle part.', '0']]), part(2, [[0, 'Third part.', '0']])];
    editor.set(mergeParts(all, { partCount: 3, edits: editor.edits }));

    expect(boxes(editor.element)).toHaveLength(4);
    expect(boxes(editor.element)[1]).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe('Second line, edited');
    expect([box.selectionStart, box.selectionEnd]).toEqual([3, 9]);
    expect(boxes(editor.element).map((b) => b.value)).toEqual([
      'Hello there.',
      'Second line, edited',
      'Middle part.',
      'Third part.',
    ]);
  });

  it('keeps the focused speaker name field while speakers are added', () => {
    const { editor } = mount();
    const first = [part(0, [[0, 'Hi.', '0']])];
    editor.set(mergeParts(first, { partCount: 2 }));
    const name = editor.element.querySelector<HTMLInputElement>(
      '[data-testid="stt-speaker-name"]',
    )!;
    name.focus();
    name.value = 'An';
    name.dispatchEvent(new Event('input'));
    name.setSelectionRange(1, 2);
    editor.set(mergeParts([...first, part(1, [[0, 'Bye.', '0']])], { partCount: 2 }));
    const names = [
      ...editor.element.querySelectorAll<HTMLInputElement>('[data-testid="stt-speaker-name"]'),
    ];
    expect(names).toHaveLength(2);
    expect(names[0]).toBe(name);
    expect(document.activeElement).toBe(name);
    expect([name.value, name.selectionStart, name.selectionEnd]).toEqual(['An', 1, 2]);
    expect(
      [...editor.element.querySelectorAll('[data-testid="stt-segment-speaker"]')].map(
        (badge) => badge.textContent,
      ),
    ).toEqual(['An', 'Speaker 1 (part 2)']);
  });

  it('updates a segment that is not being edited, and removes segments that went away', () => {
    const { editor } = mount();
    editor.set(
      mergeParts(
        [
          part(0, [
            [0, 'One.'],
            [10, 'Two.'],
          ]),
        ],
        { partCount: 1 },
      ),
    );
    const [one] = boxes(editor.element);
    editor.set(mergeParts([part(0, [[0, 'One!']])], { partCount: 1 }));
    expect(boxes(editor.element)).toHaveLength(1);
    expect(boxes(editor.element)[0]).toBe(one);
    expect(one!.value).toBe('One!');
  });
});
