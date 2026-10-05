import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { CoreServices } from '../../core/types';
import { getTool } from '../../tools/registry';
import type { ToolManifest } from '../../tools/types';
import { h } from '../dom';
import { createToolTestContext } from './testing';
import type { ToolContext, ToolInstance } from './types';

/** What the mocked page shell hands to `mountTool`'s render function. */
const page = vi.hoisted(
  (): { core: unknown; main: HTMLElement | null; built: Promise<void> | null } => ({
    core: null,
    main: null,
    built: null,
  }),
);

vi.mock('../shell/index', () => ({
  mountPage: (_options: unknown, render: (context: unknown) => void | Promise<void>) => {
    page.built = Promise.resolve(
      render({ core: page.core, main: page.main, navigate: () => Promise.resolve(true) }),
    );
  },
}));

// Imported after the mock is in place.
const { mountTool } = await import('./index');

const $ = (testId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  history.replaceState(null, '', '/');
});

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
});

/** Mounts a tool page over a fake core; resolves with the core and the context `setup` got. */
async function mount(
  manifest: ToolManifest,
  options: { freeOnly?: boolean; run?: () => Promise<void> } = {},
): Promise<{ core: CoreServices; ctx: ToolContext; runs: number[] }> {
  const t = createToolTestContext(manifest);
  const core = t.core;
  if (options.freeOnly) {
    core.settings.update((draft) => {
      draft.freeOnly = true;
    });
  }
  page.core = core;
  page.main = h('main');
  document.body.append(page.main);
  let ctx: ToolContext | null = null;
  const runs: number[] = [];
  mountTool(manifest, (context): ToolInstance => {
    ctx = context;
    context.ui.runner({
      run: (_signal, arg) => {
        runs.push(arg === undefined ? 0 : 1);
        return Promise.resolve();
      },
    });
    return { getState: () => ({ prompt: '', settings: {} }), applyState: () => undefined };
  });
  await page.built;
  return { core, ctx: ctx!, runs };
}

describe('the tool page header', () => {
  it('shows the model chip of a tool with one model', async () => {
    await mount(getTool('chat'));
    expect($('model-chip')).not.toBeNull();
  });

  it('shows none for a tool that chooses its own models, and still shows the other chips', async () => {
    await mount(getTool('model-arena'));
    expect(getTool('model-arena').ownModels).toBe(true);
    expect($('model-chip')).toBeNull();
    expect($('tool-chips')).not.toBeNull();
    expect($('drawer-button')).not.toBeNull();
  });

  it('keeps the free-only notice and a disabled Run when such a tool has no model at all', async () => {
    // No free video model exists, so free-only mode leaves this tool nothing to run.
    const blocked: ToolManifest = { ...getTool('model-arena'), capabilities: ['video'] };
    const { ctx } = await mount(blocked, { freeOnly: true });
    expect($('free-only-notice')).not.toBeNull();
    expect($('free-only-notice')?.textContent).toContain('cannot run in free-only mode');
    expect($('model-chip')).toBeNull();
    expect(ctx.model().model).toBeNull();
    expect($('run-button')?.getAttribute('aria-disabled')).toBe('true');
    expect($('run-hint')?.textContent).toContain('free-only');
  });

  it('says which model free-only mode substituted for a tool with one model, but not for one with its own', async () => {
    await mount(getTool('chat'), { freeOnly: true });
    expect($('model-note')?.textContent).toContain('Free-only mode: using');
    document.body.replaceChildren();

    await mount(getTool('model-arena'), { freeOnly: true });
    expect($('model-note')).toBeNull();
    expect($('free-only-notice')).toBeNull();
    expect($('run-button')?.getAttribute('aria-disabled')).toBe('false');
  });

  it('still hands ?model= to the tool as modelOverride', async () => {
    history.replaceState(null, '', '/?model=meta%2Fllama-x');
    const { ctx } = await mount(getTool('model-arena'));
    expect(ctx.modelOverride).toBe('meta/llama-x');
    expect($('model-chip')).toBeNull();
    // The visit's model is what the tool resolves for its primary capability.
    expect(ctx.model().model).toBe('meta/llama-x');
  });
});

describe('Ctrl/Cmd+Enter', () => {
  it('runs the first runner with no argument', async () => {
    const { runs } = await mount(getTool('chat'));
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => expect(runs).toEqual([0]));
  });
});
