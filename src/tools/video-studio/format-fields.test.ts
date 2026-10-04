import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FORMAT } from './format';
import { formatFields } from './format-fields';
import { videoControls } from './params';

const SEEDED = videoControls({
  id: 'seeded',
  name: 'Seeded',
  supported_durations: [5],
  seed: true,
});
const UNSEEDED = videoControls({ id: 'plain', name: 'Plain', supported_durations: [5] });

afterEach(() => document.body.replaceChildren());

function fields() {
  const changes: unknown[] = [];
  const view = formatFields({ onChange: (patch) => void changes.push(patch) });
  document.body.append(view.main, view.drawer);
  const seed = view.drawer.querySelector<HTMLInputElement>('input[type="number"]')!;
  return { view, changes, seed };
}

describe('seed field', () => {
  it('says when an entry is not a seed, and sends none until it is fixed', () => {
    const { view, changes, seed } = fields();
    view.render(DEFAULT_FORMAT, SEEDED);
    seed.value = '1.5';
    seed.dispatchEvent(new Event('change'));
    expect(seed.getAttribute('aria-invalid')).toBe('true');
    expect(view.drawer.textContent).toContain('Enter a whole number from 0 to 4,294,967,295');
    expect(changes.at(-1)).toEqual({ seed: null });
    seed.value = '42';
    seed.dispatchEvent(new Event('change'));
    expect(seed.getAttribute('aria-invalid')).toBeNull();
    expect(changes.at(-1)).toEqual({ seed: 42 });
  });

  it('shows what will be sent: nothing for a model without a seed', () => {
    const { view, seed } = fields();
    view.render({ ...DEFAULT_FORMAT, seed: 7 }, SEEDED);
    expect(seed.value).toBe('7');
    expect(seed.disabled).toBe(false);
    view.render({ ...DEFAULT_FORMAT, seed: 7 }, UNSEEDED);
    expect(seed.value).toBe('');
    expect(seed.disabled).toBe(true);
    expect(seed.placeholder).toBe('Not sent');
  });
});
