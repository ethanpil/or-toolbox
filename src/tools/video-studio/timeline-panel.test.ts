import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampTrim, type TimelineClip } from './timeline';
import { timelinePanel, type TimelinePanelHost } from './timeline-panel';

const clip = (id: string, patch: Partial<TimelineClip> = {}): TimelineClip => ({
  id,
  name: `${id}.mp4`,
  source: 'upload',
  jobId: null,
  remoteId: null,
  keyId: null,
  model: null,
  prompt: '',
  duration: 1,
  trimStart: 0,
  trimEnd: 0,
  continues: false,
  dropFirstFrame: false,
  included: true,
  sequenceId: null,
  slotKey: null,
  attempt: 1,
  expired: false,
  staleSource: false,
  createdAt: 1,
  ...patch,
});

function panel(clips: TimelineClip[]) {
  const moves: [string, number][] = [];
  const host: TimelinePanelHost = {
    state: () => ({ kind: 'missing', message: 'Not here.' }),
    downloadButton: () => null,
    describe: () => [],
    move: (id, delta) => void moves.push([id, delta]),
    trim: (id, start, end) =>
      clampTrim(clips.find((c) => c.id === id)?.duration ?? null, start, end),
    setIncluded: vi.fn(),
    setDropFirstFrame: vi.fn(),
    continueFrom: vi.fn(),
    extend: vi.fn(),
    frames: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
    join: vi.fn(),
    stopJoin: vi.fn(),
  };
  const view = timelinePanel(host);
  document.body.append(view.element);
  view.render(clips, { busy: false, blocked: null });
  return { view, moves };
}

const $$ = (testId: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

afterEach(() => {
  document.body.replaceChildren();
});

describe('timeline panel', () => {
  it('shows the stored trim after a value the clip cannot take, and says why', () => {
    panel([clip('a')]);
    const input = $$('video-trim-end')[0] as HTMLInputElement;
    input.value = '5';
    input.dispatchEvent(new Event('change'));
    expect(input.value).toBe('0.9');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const note = $$('video-trim-end-note')[0]!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('0.9 s is the most this trim can be');
    expect(input.getAttribute('aria-describedby')).toBe(note.id);
    // A value it takes clears the warning.
    input.value = '0.25';
    input.dispatchEvent(new Event('change'));
    expect(input.value).toBe('0.25');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(note.hidden).toBe(true);
    // Negative: 0, and said.
    const start = $$('video-trim-start')[0] as HTMLInputElement;
    start.value = '-2';
    start.dispatchEvent(new Event('change'));
    expect(start.value).toBe('0');
    expect($$('video-trim-start-note')[0]?.textContent).toContain('cannot be negative');
  });

  it("names the clip and the unit in the trim fields' labels", () => {
    panel([clip('harbour')]);
    const input = $$('video-trim-start')[0] as HTMLInputElement;
    const label = document.querySelector(`label[for="${input.id}"]`);
    expect(label?.textContent).toBe('Trim start of harbour.mp4, in seconds');
  });

  it('keeps the reorder buttons focusable at the ends (aria-disabled), and moves nothing there', () => {
    const { moves } = panel([clip('a'), clip('b')]);
    const [firstUp, secondUp] = $$('video-clip-up') as HTMLButtonElement[];
    const [firstDown, secondDown] = $$('video-clip-down') as HTMLButtonElement[];
    expect(firstUp?.disabled).toBe(false);
    expect(firstUp?.getAttribute('aria-disabled')).toBe('true');
    expect(secondDown?.getAttribute('aria-disabled')).toBe('true');
    firstUp?.click();
    secondDown?.click();
    expect(moves).toEqual([]);
    firstDown?.click();
    secondUp?.click();
    expect(moves).toEqual([
      ['a', 1],
      ['b', -1],
    ]);
    expect(firstDown?.getAttribute('aria-label')).toBe('Move a.mp4 down');
  });
});
