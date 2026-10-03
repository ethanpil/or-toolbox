/**
 * Writes to the settings that several pages make the same way. Every one shows a failed save (storage full)
 * through `presentError` and returns whether it worked, so a control can go back to what is stored.
 */
import type { CoreServices, Settings, ThemeMode, ToolId } from '../core/types';
import { presentError } from './feedback/errors';

type WithSettings = Pick<CoreServices, 'settings'>;

export interface SaveSettingsOptions {
  /** Replaces the default `presentError` (for a write that is only a convenience, like a remembered tab). */
  onError?: (error: unknown) => void;
}

/** Applies a settings change; shows the error and returns false when it fails. */
export function saveSettings(
  core: WithSettings,
  mutate: (draft: Settings) => void,
  options: SaveSettingsOptions = {},
): boolean {
  try {
    core.settings.update(mutate);
    return true;
  } catch (error) {
    if (options.onError) options.onError(error);
    else void presentError(error);
    return false;
  }
}

/** The list with `item` removed when it is in it, added at the end when it is not. */
function toggled<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];
}

/** Stars or unstars a model. Resolves to its new state, or null when the change could not be saved. */
export function toggleFavouriteModel(core: WithSettings, id: string): boolean | null {
  let on = false;
  const saved = saveSettings(core, (draft) => {
    draft.models.favourites = toggled(draft.models.favourites, id);
    on = draft.models.favourites.includes(id);
  });
  return saved ? on : null;
}

/** Stars or unstars a tool on Home. Resolves to its new state, or null when it could not be saved. */
export function toggleFavouriteTool(core: WithSettings, id: ToolId): boolean | null {
  let on = false;
  const saved = saveSettings(core, (draft) => {
    draft.favouriteTools = toggled(draft.favouriteTools, id);
    on = draft.favouriteTools.includes(id);
  });
  return saved ? on : null;
}

/** What to change in a tool's pins: a string sets it, `null` clears it, `undefined` leaves it alone. */
export interface ToolBindingPatch {
  model?: string | null;
  keyId?: string | null;
}

/** Pins (or unpins) the model and/or key one tool uses; the tool's other saved options are kept. */
export function setToolBinding(core: WithSettings, tool: ToolId, patch: ToolBindingPatch): boolean {
  return saveSettings(core, (draft) => {
    const binding = { ...draft.tools[tool] };
    for (const field of ['model', 'keyId'] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      if (value) binding[field] = value;
      else delete binding[field];
    }
    draft.tools[tool] = binding;
  });
}

export function setTheme(core: WithSettings, mode: ThemeMode): boolean {
  return saveSettings(core, (draft) => {
    draft.appearance.theme = mode;
  });
}
