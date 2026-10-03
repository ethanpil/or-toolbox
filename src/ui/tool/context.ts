/**
 * Builds a `ToolContext` around a `ToolUi`. Shared by `mountTool` (the real page) and `createToolTestContext`
 * (unit tests), so the run, model and estimate rules a tool relies on are the same in both.
 */
import { InvalidInputError } from '../../core/errors';
import type { Capability, CoreServices, ResolvedModel, ToolManifest } from '../../core/types';
import type { EstimateTracker } from './estimate';
import type { ToolContext, ToolInstance, ToolOptions, ToolUi } from './types';

export interface ContextParts {
  core: CoreServices;
  manifest: ToolManifest;
  ui: ToolUi;
  estimates: EstimateTracker;
  /** `?model=` for this visit, or null. */
  modelOverride: () => string | null;
  /** The instance once `setup` returned (beginRun reads its state). */
  instance: () => ToolInstance | null;
}

/** The model for a capability; the override only reaches the primary one (the core applies the same rule). */
export function resolveFor(
  core: Pick<CoreServices, 'models'>,
  manifest: ToolManifest,
  override: string | null,
  capability: Capability = manifest.capabilities[0]!,
): ResolvedModel {
  const primary = capability === manifest.capabilities[0];
  return core.models.resolve(
    manifest.id,
    capability,
    primary ? (override ?? undefined) : undefined,
  );
}

export function createToolContext(parts: ContextParts): ToolContext {
  const { core, manifest, ui, estimates } = parts;
  const model = (capability?: Capability): ResolvedModel =>
    resolveFor(core, manifest, parts.modelOverride(), capability);

  const options: ToolOptions = {
    get: () => core.settings.toolOptions(manifest),
    set(patch) {
      const saved = core.settings.get().tools[manifest.id]?.options ?? {};
      core.settings.setToolOptions(manifest.id, { ...saved, ...patch });
    },
    reset() {
      core.settings.setToolOptions(manifest.id, {});
    },
  };

  return {
    ...core,
    manifest,
    state: core.toolState(manifest.id),
    options,
    ui,
    model,
    get modelOverride() {
      return parts.modelOverride();
    },
    async beginRun(spec, signal) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Stopped.', 'AbortError');
      }
      const resolved = model();
      const chosen = spec.model ?? resolved.model;
      if (!chosen) {
        throw new InvalidInputError(resolved.note ?? 'No model is available for this tool.');
      }
      const snapshot = parts.instance()?.getState();
      const prompt = spec.prompt ?? snapshot?.prompt;
      const settings = spec.settings ?? snapshot?.settings;
      // The framework's estimate (recomputed if the model or the input changed since) is what budgets reserve,
      // unless the tool passes its own. It only applies to the model it was computed for.
      const estimateUsd =
        spec.estimateUsd !== undefined
          ? spec.estimateUsd
          : chosen === resolved.model
            ? await estimates.current()
            : null;
      const addons = spec.addons ?? parts.instance()?.addons?.() ?? [];
      const handle = await core.runs.begin({
        ...spec,
        addons,
        tool: spec.tool ?? manifest.id,
        model: chosen,
        estimateUsd,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(settings !== undefined ? { settings } : {}),
      });
      if (signal) {
        if (signal.aborted) handle.abort('Stopped by the user.');
        else {
          signal.addEventListener('abort', () => handle.abort('Stopped by the user.'), {
            once: true,
          });
        }
      }
      return handle;
    },
  };
}
