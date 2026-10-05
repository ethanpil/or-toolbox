import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { getTool } from '../../tools/registry';
import { createToolTestContext } from '../../ui/tool/testing';
import { capabilityDefault } from './logic';
import { toolsSection } from './tools';

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
});

afterEach(() => {
  document.body.replaceChildren();
});

function render() {
  const t = createToolTestContext(getTool('chat'));
  const { element } = toolsSection(t.core);
  document.body.append(element);
  const row = (id: string): HTMLElement =>
    element.querySelector<HTMLElement>(`[data-testid="tool-row-${id}"]`)!;
  const part = (id: string, testId: string): HTMLElement | null =>
    row(id).querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return { t, element, row, part };
}

describe('Settings → Tools', () => {
  it('lets a tool with one model pin it', () => {
    const { part } = render();
    expect(part('chat', 'tool-model-change')).not.toBeNull();
    expect(part('chat', 'tool-model')?.textContent).toContain('Default for');
  });

  it('shows a line instead of a model picker for tools that choose their own models', () => {
    const { part } = render();
    for (const id of ['model-arena', 'bot-to-bot']) {
      expect(part(id, 'tool-model-change'), id).toBeNull();
      const cell = part(id, 'tool-model')!;
      expect(cell.hasAttribute('data-own-models'), id).toBe(true);
      expect(cell.textContent, id).toContain('Chosen inside the tool');
      expect(cell.textContent, id).toContain('New setups start from');
      expect(cell.querySelector('a')?.getAttribute('href'), id).toContain('#models');
    }
  });

  it('names the starting model: the capability default, or a binding saved earlier, which Reset clears', async () => {
    const { t, part } = render();
    const start = (): string => part('model-arena', 'tool-model')!.textContent ?? '';
    const defaultText = capabilityDefault(t.core.settings.get(), 'text').model;
    expect(start()).toContain(defaultText);
    expect(part('model-arena', 'tool-reset')).toHaveProperty('disabled', true);

    t.core.settings.update((draft) => {
      draft.tools['model-arena'] = { model: 'pinned/earlier' };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(start()).toContain('pinned/earlier');
    const reset = part('model-arena', 'tool-reset') as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    reset.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(start()).toContain(defaultText);
  });
});
