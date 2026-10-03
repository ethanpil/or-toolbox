/**
 * Composition root: the one place that creates the core services for a page.
 *
 * Every factory receives the shared `core` object and reads its dependencies lazily at call time, so the
 * order below only matters for readability, and circular dependencies (keys ↔ api ↔ models) resolve
 * naturally. Pages, the shell and tools call `getCore()`; nothing else constructs services.
 */

import { createApiClient } from './api/client';
import { createBackupService } from './backup';
import { createBudgetsService } from './budgets';
import { createBus } from './bus';
import { createDataService } from './data';
import { createHistoryService } from './history';
import { createJobsService } from './jobs';
import { createKeysService } from './keys/keys';
import { createModelsService } from './models/models';
import { createOAuthService } from './oauth/oauth';
import { createPromptsService } from './prompts';
import { createResultsService } from './results';
import { createRunsService } from './runs';
import { createSettingsService } from './settings';
import { createStatsService } from './stats';
import { createToolStateStore } from './tool-state';
import type { CoreServices } from './types';

let instance: CoreServices | null = null;

/** The page's single core instance, created on first use. */
export function getCore(): CoreServices {
  if (instance) return instance;

  const core = {} as CoreServices;
  core.bus = createBus();
  core.settings = createSettingsService(core);
  core.keys = createKeysService(core);
  core.oauth = createOAuthService(core);
  core.models = createModelsService(core);
  core.api = createApiClient(core);
  core.budgets = createBudgetsService(core);
  core.runs = createRunsService(core);
  core.history = createHistoryService(core);
  core.prompts = createPromptsService(core);
  core.jobs = createJobsService(core);
  core.stats = createStatsService(core);
  core.results = createResultsService(core);
  core.backup = createBackupService(core);
  core.data = createDataService(core);

  // Stateless: a key-prefix closure per call, telling the bus about changes.
  core.toolState = (tool) => createToolStateStore(tool, core.bus);

  instance = core;
  return core;
}
