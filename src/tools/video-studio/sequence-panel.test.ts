// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SEQUENCE } from './sequence';
import { sequencePanel, type SequencePanelHost } from './sequence-panel';

function build() {
  const onSpec = vi.fn();
  const host = {
    ui: { status: vi.fn() },
    onSpec,
    onSteps: vi.fn(),
    onStepEdit: vi.fn(),
    onSource: vi.fn(),
    onImages: vi.fn(),
    newStepId: () => 'x',
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
    rerun: vi.fn(),
    chooseSource: vi.fn(),
    dropImages: vi.fn(),
    rerunPrevious: vi.fn(),
  } as unknown as SequencePanelHost;
  const panel = sequencePanel(host);
  document.body.append(panel.element);
  panel.render({
    spec: { ...DEFAULT_SEQUENCE, capUsd: 0.5 },
    run: null,
    clips: [],
    sourceId: null,
    lastFrame: true,
    perStep: null,
    total: null,
    blocked: null,
    resumeBlocked: null,
  });
  const cap = panel.element.querySelector<HTMLInputElement>('[data-testid="seq-cap"]')!;
  const type = (text: string): void => {
    cap.value = text;
    cap.dispatchEvent(new Event('change'));
  };
  return { cap, onSpec, type, panel };
}

describe('spend cap field', () => {
  it('refuses 0 and negative amounts with an inline error and leaves the cap as it was', () => {
    const { cap, onSpec, type } = build();
    for (const text of ['0', '-5', '0.00']) {
      type(text);
      expect(onSpec).not.toHaveBeenCalled();
      expect(cap.getAttribute('aria-invalid')).toBe('true');
      expect(cap.getAttribute('aria-describedby')).toMatch(/\S+ \S+/);
    }
  });

  it('accepts an amount, and an empty field means no cap', () => {
    const { cap, onSpec, type } = build();
    type('0');
    type('0.25');
    expect(onSpec).toHaveBeenLastCalledWith({ capUsd: 0.25 });
    expect(cap.getAttribute('aria-invalid')).toBeNull();
    type('');
    expect(onSpec).toHaveBeenLastCalledWith({ capUsd: null });
  });
});
