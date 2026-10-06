import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmDiscard } from './discard';

const hoisted = vi.hoisted(() => ({ confirm: vi.fn(() => Promise.resolve(true)) }));
vi.mock('../feedback/dialogs', () => ({ confirmDialog: hoisted.confirm }));

afterEach(() => {
  hoisted.confirm.mockReset();
  hoisted.confirm.mockImplementation(() => Promise.resolve(true));
});

describe('confirmDiscard', () => {
  it('goes ahead at once when nothing would be lost', async () => {
    await expect(
      confirmDiscard({ what: 'your edited transcript', isDirty: () => false }),
    ).resolves.toBe(true);
    expect(hoisted.confirm).not.toHaveBeenCalled();
  });

  it('asks, naming what would be lost, and says what the user chose', async () => {
    hoisted.confirm.mockImplementation(() => Promise.resolve(false));
    await expect(
      confirmDiscard({
        what: 'your edited transcript and speaker names',
        isDirty: () => true,
        testId: 'stt-discard',
      }),
    ).resolves.toBe(false);
    expect(hoisted.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Replace your work?',
        message:
          'This replaces your edited transcript and speaker names. It is not saved anywhere else.',
        confirmLabel: 'Replace',
        tone: 'warning',
        testId: 'stt-discard',
      }),
    );
  });

  it('takes its own title and button text; without isDirty it always asks', async () => {
    await confirmDiscard({
      what: '2 versions not downloaded',
      title: 'Start over?',
      confirmLabel: 'Start over',
    });
    expect(hoisted.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Start over?',
        confirmLabel: 'Start over',
        testId: 'discard-dialog',
      }),
    );
  });
});
