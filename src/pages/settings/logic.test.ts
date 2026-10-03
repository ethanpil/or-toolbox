import { beforeEach, describe, expect, it } from 'vitest';
import { isolateChannels, testCore } from '../../core/api/test-fakes';
import { createModelsService } from '../../core/models/models';
import type { ApiClient, Settings } from '../../core/types';
import { tools } from '../../tools/registry';
import { CAPABILITIES } from '../../tools/types';
import {
  backupFilename,
  capabilityDefault,
  freeOnlyImpact,
  freeOnlyModel,
  isDestructiveChange,
  parseUsd,
  parseWhole,
  passphraseStrength,
  sectionFromHash,
  spendMeter,
  storageUsage,
  usdFieldValue,
} from './logic';

describe('sectionFromHash', () => {
  it('names a known section, else null', () => {
    expect(sectionFromHash('#budgets')).toBe('budgets');
    expect(sectionFromHash('keys')).toBe('keys');
    expect(sectionFromHash('#nope')).toBeNull();
    expect(sectionFromHash('')).toBeNull();
    expect(sectionFromHash('#__proto__')).toBeNull();
  });
});

describe('parseUsd', () => {
  it('reads plain, prefixed and grouped amounts', () => {
    expect(parseUsd('5', { max: 100 })).toEqual({ ok: true, value: 5 });
    expect(parseUsd(' $0.25 ', { max: 100 })).toEqual({ ok: true, value: 0.25 });
    expect(parseUsd('1,000', { max: 100_000 })).toEqual({ ok: true, value: 1000 });
    expect(parseUsd('.5', { max: 1 })).toEqual({ ok: true, value: 0.5 });
    expect(parseUsd('0', { max: 1 })).toEqual({ ok: true, value: 0 });
    expect(parseUsd('0.1000000001', { max: 1 })).toEqual({ ok: true, value: 0.1 });
  });

  it('treats empty as no limit only when optional', () => {
    expect(parseUsd('  ', { max: 1, optional: true })).toEqual({ ok: true, value: null });
    expect(parseUsd('', { max: 1 })).toMatchObject({ ok: false });
  });

  it('refuses negative, non-numeric and too large amounts', () => {
    expect(parseUsd('-1', { max: 10 })).toMatchObject({ ok: false });
    expect(parseUsd('abc', { max: 10 })).toMatchObject({ ok: false });
    expect(parseUsd('1e3', { max: 1e6 })).toMatchObject({ ok: false });
    expect(parseUsd('1.2.3', { max: 10 })).toMatchObject({ ok: false });
    expect(parseUsd('11', { max: 10 })).toEqual({ ok: false, error: 'Enter at most $10.00.' });
  });

  it('reads a decimal comma as cents, never as thousands', () => {
    expect(parseUsd('0,25', { max: 100 })).toEqual({ ok: true, value: 0.25 });
    expect(parseUsd('1,5', { max: 100 })).toEqual({ ok: true, value: 1.5 });
    expect(parseUsd('$12,50', { max: 100 })).toEqual({ ok: true, value: 12.5 });
  });

  it('keeps thousands separators with or without cents', () => {
    expect(parseUsd('1,234.56', { max: 100_000 })).toEqual({ ok: true, value: 1234.56 });
    expect(parseUsd('12,345,678', { max: 1e9 })).toEqual({ ok: true, value: 12_345_678 });
  });

  it('refuses amounts whose comma could mean either', () => {
    const ambiguous = {
      ok: false,
      error: 'Use a dot for cents and commas only between thousands, like 1,234.50.',
    };
    expect(parseUsd('0,250', { max: 100 })).toEqual(ambiguous);
    expect(parseUsd('1,2345', { max: 100_000 })).toEqual(ambiguous);
    expect(parseUsd('1,23.4', { max: 100 })).toEqual(ambiguous);
    expect(parseUsd('1.234,56', { max: 100_000 })).toEqual(ambiguous);
    expect(parseUsd('1,,5', { max: 100 })).toEqual(ambiguous);
  });
});

describe('parseWhole', () => {
  it('accepts whole numbers in range', () => {
    expect(parseWhole('0', { min: 0, max: 1440 })).toEqual({ ok: true, value: 0 });
    expect(parseWhole(' 90 ', { min: 1, max: 3650 })).toEqual({ ok: true, value: 90 });
  });

  it('accepts thousands separators, as its own message prints them', () => {
    expect(parseWhole('1,440', { min: 0, max: 1440 })).toEqual({ ok: true, value: 1440 });
    expect(parseWhole('1,44', { min: 0, max: 1440 })).toMatchObject({ ok: false });
    expect(parseWhole('0,440', { min: 0, max: 1440 })).toMatchObject({ ok: false });
  });

  it('refuses fractions, signs, text and out-of-range values', () => {
    const error = { ok: false, error: 'Enter a whole number from 1 to 3,650.' };
    expect(parseWhole('1.5', { min: 1, max: 3650 })).toEqual(error);
    expect(parseWhole('-1', { min: 1, max: 3650 })).toEqual(error);
    expect(parseWhole('', { min: 1, max: 3650 })).toEqual(error);
    expect(parseWhole('0', { min: 1, max: 3650 })).toEqual(error);
    expect(parseWhole('3651', { min: 1, max: 3650 })).toEqual(error);
  });
});

describe('usdFieldValue', () => {
  it('shows cents for whole-cent amounts and keeps smaller precision', () => {
    expect(usdFieldValue(null)).toBe('');
    expect(usdFieldValue(0.1)).toBe('0.10');
    expect(usdFieldValue(12.5)).toBe('12.50');
    expect(usdFieldValue(0.005)).toBe('0.005');
    expect(usdFieldValue(0)).toBe('0');
  });
});

describe('spendMeter', () => {
  it('is null without a limit', () => {
    expect(spendMeter(3, null)).toBeNull();
  });

  it('turns from success to warning at 80 % and to danger at the limit', () => {
    expect(spendMeter(1.2, 5)).toEqual({
      percent: 24,
      tone: 'success',
      reached: false,
      text: '$1.20 of $5.00 · $3.80 left',
    });
    expect(spendMeter(4, 5)).toMatchObject({ percent: 80, tone: 'warning', reached: false });
    expect(spendMeter(5, 5)).toMatchObject({ percent: 100, tone: 'danger', reached: true });
    expect(spendMeter(7.5, 5)).toEqual({
      percent: 100,
      tone: 'danger',
      reached: true,
      text: '$7.50 of $5.00 · limit reached',
    });
  });

  it('treats a zero limit as reached', () => {
    expect(spendMeter(0, 0)).toMatchObject({ percent: 100, tone: 'danger', reached: true });
  });
});

describe('capability defaults and free-only', () => {
  const settings = (patch: Partial<Settings> = {}): Pick<Settings, 'defaultModels' | 'tools'> => ({
    defaultModels: {},
    tools: {},
    ...patch,
  });

  it('reports the shipped default unless the user chose another', () => {
    expect(capabilityDefault(settings(), 'text')).toEqual({
      model: 'openai/gpt-6-luna',
      custom: false,
      shipped: 'openai/gpt-6-luna',
    });
    expect(capabilityDefault(settings({ defaultModels: { text: 'x/y' } }), 'text')).toMatchObject({
      model: 'x/y',
      custom: true,
    });
  });

  it('lists the capabilities and tools free-only mode blocks', () => {
    const impact = freeOnlyImpact(settings(), CAPABILITIES, tools);
    expect(impact.capabilities).toEqual(['image', 'stt', 'video', 'music']);
    expect(impact.tools.map((tool) => tool.id)).toEqual([
      'speech-to-text',
      'music-generation',
      'image-generation',
      'image-editor',
      'isolated-image',
      'video-studio',
    ]);
  });

  it('unblocks a capability or tool once a free model is chosen for it', () => {
    const impact = freeOnlyImpact(
      settings({
        defaultModels: { stt: 'some/whisper:free' },
        tools: { 'video-studio': { model: 'openrouter/free' } },
      }),
      CAPABILITIES,
      tools,
    );
    expect(impact.capabilities).toEqual(['image', 'video', 'music']);
    expect(impact.tools.map((tool) => tool.id)).not.toContain('speech-to-text');
    expect(impact.tools.map((tool) => tool.id)).not.toContain('video-studio');
  });

  describe('agrees with ModelsService.resolve in free-only mode', () => {
    beforeEach(() => {
      isolateChannels();
      localStorage.clear();
    });

    const cases: [string, (draft: Settings) => void][] = [
      ['shipped defaults', () => undefined],
      [
        'free and paid choices',
        (draft) => {
          draft.defaultModels.text = 'a/paid';
          draft.defaultModels.tts = 'b/voice:free';
          draft.defaultModels.image = 'c/image:free';
          draft.tools.chat = { model: 'd/chat:free' };
          draft.tools.ocr = { model: 'e/paid' };
          draft.tools['video-studio'] = { model: 'openrouter/free' };
        },
      ],
    ];
    for (const [name, patch] of cases) {
      it(name, () => {
        const core = testCore({ api: {} as ApiClient });
        core.models = createModelsService(core);
        core.settings.update((draft) => {
          patch(draft);
          draft.freeOnly = true;
        });
        const current = core.settings.get();
        for (const tool of tools) {
          for (const capability of tool.capabilities) {
            expect(freeOnlyModel(current, capability, tool.id), `${tool.id}/${capability}`).toBe(
              core.models.resolve(tool.id, capability).model,
            );
          }
        }
      });
    }
  });
});

describe('passphraseStrength', () => {
  it('refuses short passphrases', () => {
    expect(passphraseStrength('')).toMatchObject({ score: 0, label: 'Too short' });
    expect(passphraseStrength('abc1234')).toMatchObject({ score: 0 });
  });

  it('rewards length and variety', () => {
    expect(passphraseStrength('abcdefgh').score).toBe(1);
    expect(passphraseStrength('abcdefghijkl').score).toBe(2);
    expect(passphraseStrength('correct horse battery staple')).toMatchObject({
      score: 3,
      label: 'Good',
    });
    expect(passphraseStrength('Correct horse battery 9!')).toMatchObject({
      score: 4,
      label: 'Strong',
    });
  });

  it('marks common and repeated passphrases weak', () => {
    expect(passphraseStrength('MyPassword2026!!').score).toBe(1);
    expect(passphraseStrength('aaaaaaaaaaaaaaaaaaaa').score).toBe(1);
  });
});

describe('isDestructiveChange', () => {
  it('picks out the lines that delete or overwrite', () => {
    for (const line of [
      'Delete 3 saved prompts',
      'Replace 2 keys with 1 from the backup',
      'Replace all settings (4 settings differ)',
      'Turn off the passphrase lock',
      'Use the backup’s passphrase lock',
      '2 tool key pins removed: their keys are not in this browser',
      'Default key cleared: it is not in this browser',
    ]) {
      expect(isDestructiveChange(line), line).toBe(true);
    }
    for (const line of [
      'Add 120 runs',
      'Update 2 jobs',
      'Settings unchanged',
      'Change 2 settings: budgets.mode, freeOnly',
      'Skip keys (enter the backup passphrase to import them)',
      'Turn on the backup’s passphrase lock',
    ]) {
      expect(isDestructiveChange(line), line).toBe(false);
    }
  });
});

describe('backupFilename', () => {
  it('uses the local date', () => {
    expect(backupFilename(new Date(2026, 0, 5, 23, 59))).toBe(
      'ortoolbox-2026-01-05.ortoolbox.json',
    );
  });
});

describe('storageUsage', () => {
  it('reports use against the quota', () => {
    expect(storageUsage(null, 100)).toBeNull();
    expect(storageUsage(2048, null)).toEqual({ text: '2 KB used', percent: null });
    expect(storageUsage(512 * 1024, 1024 * 1024)).toEqual({
      text: '512 KB of 1 MB (50%)',
      percent: 50,
    });
    expect(storageUsage(1, 1024 * 1024 * 1024)?.text).toBe('1 B of 1 GB (<1%)');
  });
});
