import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isolateChannels, testCore } from '../core/api/test-fakes';
import { StorageFullError } from '../core/errors';
import type { CoreServices } from '../core/types';
import {
  saveSettings,
  setTheme,
  setToolBinding,
  toggleFavoriteModel,
  toggleFavoriteTool,
} from './settings-actions';

let core: CoreServices;

beforeEach(() => {
  localStorage.clear();
  isolateChannels();
  core = testCore();
});

describe('saveSettings', () => {
  it('applies the change and says so', () => {
    expect(
      saveSettings(core, (draft) => {
        draft.freeOnly = true;
      }),
    ).toBe(true);
    expect(core.settings.get().freeOnly).toBe(true);
  });

  it('hands a failure to onError (or the error toast) and returns false', () => {
    vi.spyOn(core.settings, 'update').mockImplementation(() => {
      throw new StorageFullError();
    });
    const onError = vi.fn();
    expect(saveSettings(core, () => undefined, { onError })).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.any(StorageFullError));
  });
});

describe('favorites', () => {
  it('stars and unstars a model, reporting the new state', () => {
    expect(toggleFavoriteModel(core, 'a/b')).toBe(true);
    expect(toggleFavoriteModel(core, 'c/d')).toBe(true);
    expect(core.settings.get().models.favorites).toEqual(['a/b', 'c/d']);
    expect(toggleFavoriteModel(core, 'a/b')).toBe(false);
    expect(core.settings.get().models.favorites).toEqual(['c/d']);
  });

  it('stars and unstars a tool', () => {
    expect(toggleFavoriteTool(core, 'ocr')).toBe(true);
    expect(core.settings.get().favoriteTools).toContain('ocr');
    expect(toggleFavoriteTool(core, 'ocr')).toBe(false);
    expect(core.settings.get().favoriteTools).not.toContain('ocr');
  });

  it('reports null when the change could not be saved', () => {
    vi.spyOn(core.settings, 'update').mockImplementation(() => {
      throw new StorageFullError();
    });
    expect(toggleFavoriteModel(core, 'a/b')).toBeNull();
  });
});

describe('setToolBinding', () => {
  it('pins a model and a key, keeping what else the tool saved', () => {
    core.settings.update((draft) => {
      draft.tools.ocr = { options: { language: 'de' } };
    });
    expect(setToolBinding(core, 'ocr', { model: 'x/y' })).toBe(true);
    expect(setToolBinding(core, 'ocr', { keyId: 'key-2' })).toBe(true);
    expect(core.settings.get().tools.ocr).toEqual({
      options: { language: 'de' },
      model: 'x/y',
      keyId: 'key-2',
    });
  });

  it('clears with null or an empty string, and leaves undefined alone', () => {
    setToolBinding(core, 'ocr', { model: 'x/y', keyId: 'key-2' });
    setToolBinding(core, 'ocr', { keyId: null });
    expect(core.settings.get().tools.ocr).toEqual({ model: 'x/y' });
    setToolBinding(core, 'ocr', { model: '' });
    expect(core.settings.get().tools.ocr).toEqual({});
  });
});

describe('setTheme', () => {
  it('writes the theme', () => {
    expect(setTheme(core, 'dark')).toBe(true);
    expect(core.settings.get().appearance.theme).toBe('dark');
  });
});
