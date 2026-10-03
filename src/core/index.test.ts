import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { getCore } from './index';

describe('getCore', () => {
  it('creates every service once and reuses the instance', () => {
    const core = getCore();
    for (const name of [
      'bus',
      'settings',
      'keys',
      'oauth',
      'models',
      'api',
      'budgets',
      'runs',
      'history',
      'prompts',
      'jobs',
      'stats',
      'results',
      'backup',
      'data',
    ] as const) {
      expect(core[name], name).toBeTruthy();
    }
    expect(getCore()).toBe(core);
  });

  it('gives every tool state store for a tool the same data', async () => {
    const core = getCore();
    await core.toolState('chat').set('thread', { turns: 2 });
    expect(await core.toolState('chat').get('thread')).toEqual({ turns: 2 });
    expect(await core.toolState('ocr').get('thread')).toBeUndefined();
  });

  it('resolves cross-service dependencies lazily', () => {
    const core = getCore();
    expect(core.settings.get().budgets.mode).toBe('warn');
    expect(core.keys.list()).toEqual([]);
    expect(core.models.isFree('qwen/qwen3.8-27b:free')).toBe(true);
    expect(core.models.resolve('chat', 'text').model).toBeTruthy();
  });
});
