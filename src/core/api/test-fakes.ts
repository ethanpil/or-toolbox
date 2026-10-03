/**
 * Test support for the api, keys, oauth and models tests. Import only from `*.test.ts`.
 *
 * `testCore()` builds one "tab": the real bus and settings service, plus whatever parts a test passes. Call
 * `isolateChannels()` in `beforeEach` (and clear localStorage): buses created in the same test then talk to each
 * other like tabs, and never to earlier tests' buses.
 */

import { createBus } from '../bus';
import { isFreeModelId } from '../models/free';
import { createSettingsService } from '../settings';
import { isolateChannels } from '../testing/state-fakes';
import type { CoreServices, ModelsService, RunHandle, ToolId, Usage, UsageTotals } from '../types';

export { defaultSettings } from '../settings/schema';
export { isolateChannels };

/** One tab's core: real bus and settings; `models.isFree` by default; the rest from `parts`. */
export function testCore(parts: Partial<CoreServices> = {}): CoreServices {
  const core = { ...parts } as CoreServices;
  core.bus = parts.bus ?? createBus();
  core.settings = parts.settings ?? createSettingsService(core);
  core.models = parts.models ?? ({ isFree: isFreeModelId } as unknown as ModelsService);
  return core;
}

export interface FakeRun extends RunHandle {
  usages: Usage[];
  controller: AbortController;
}

export function fakeRun(
  tool: ToolId = 'chat',
  keyId = 'key-1',
  model = 'openai/gpt-6-luna',
): FakeRun {
  const controller = new AbortController();
  const usages: Usage[] = [];
  const totals: UsageTotals = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    latencyMsTotal: 0,
    costEstimated: false,
    costUnknown: false,
    byModel: {},
  };
  return {
    id: 'run-1',
    tool,
    model,
    keyId,
    signal: controller.signal,
    controller,
    usages,
    abort: (reason?: string) => controller.abort(reason),
    addUsage: (usage) => {
      usages.push(usage);
    },
    jobId: null,
    get totals() {
      return totals;
    },
    onUsage: () => () => undefined,
    checkpoint: () => Promise.resolve(),
    finish: () => Promise.reject(new Error('not used')),
    fail: () => Promise.reject(new Error('not used')),
    handOff: () => undefined,
  };
}
