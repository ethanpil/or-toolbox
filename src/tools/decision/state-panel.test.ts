import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blankState, type StateDef } from './schema';
import { statePanel, type StatePanel } from './state-panel';

let panel: StatePanel;
let changes = 0;

beforeEach(() => {
  changes = 0;
  panel = statePanel({ onChange: () => (changes += 1) });
  document.body.append(panel.element);
});
afterEach(() => {
  panel.element.remove();
});

const $$ = (testId: string): HTMLElement[] => [
  ...panel.element.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];
const $ = (testId: string): HTMLElement => {
  const found = $$(testId)[0];
  if (!found) throw new Error(`no element with data-testid="${testId}"`);
  return found;
};

function type(element: HTMLElement, value: string): void {
  (element as HTMLInputElement).value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
const switchTo = (mode: 'text' | 'fields'): void => {
  const radio = $(mode === 'text' ? 'dec-mode-text' : 'dec-mode-fields') as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
};
const promptField = (): HTMLTextAreaElement => $('tool-prompt') as HTMLTextAreaElement;
const invalid = (element: HTMLElement): boolean => element.getAttribute('aria-invalid') === 'true';

describe('the situation panel', () => {
  it('starts in text mode with the main prompt field', () => {
    expect(promptField().getAttribute('data-testid')).toBe('tool-prompt');
    expect(panel.state()).toEqual(blankState());
    expect(panel.state().mode).toBe('text');
    expect(promptField().closest('[hidden]')).toBeNull();
    expect($('dec-fields').closest('[hidden]')).not.toBeNull();
  });

  it('switches between the text block and the fields, keeping both', () => {
    type(promptField(), 'A ticket');
    switchTo('fields');
    expect(panel.state().mode).toBe('fields');
    expect(promptField().closest('[hidden]')).not.toBeNull();
    expect($('dec-fields').closest('[hidden]')).toBeNull();
    type($('dec-field-key'), 'tier');
    type($('dec-field-value'), 'pro');
    switchTo('text');
    expect(promptField().value).toBe('A ticket');
    expect(panel.state().fields).toEqual([{ key: 'tier', value: 'pro' }]);
    expect(changes).toBeGreaterThan(0);
  });

  it('adds, removes and reorders fields, and says what happened', () => {
    switchTo('fields');
    $('dec-add-field').click();
    $('dec-add-field').click();
    const keys = (): string[] => ($$('dec-field-key') as HTMLInputElement[]).map((k) => k.value);
    ($$('dec-field-key') as HTMLInputElement[]).forEach((input, i) => type(input, `k${i}`));
    expect(keys()).toEqual(['k0', 'k1', 'k2']);
    // The first and last cannot move past the ends.
    const move = (label: string): HTMLButtonElement =>
      panel.element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    expect(move('Move field 1 up').disabled).toBe(true);
    expect(move('Move field 3 down').disabled).toBe(true);
    move('Move field 1 down').click();
    expect(keys()).toEqual(['k1', 'k0', 'k2']);
    move('Remove field 2').click();
    expect(keys()).toEqual(['k1', 'k2']);
    expect(document.activeElement).toBe(move('Remove field 2'));
  });

  it('puts new fields in focus, name first', () => {
    switchTo('fields');
    $('dec-add-field').click();
    expect(document.activeElement).toBe($$('dec-field-key')[1]);
  });

  it('keeps focus on a moved field’s button, falling back to its twin at the end', () => {
    panel.setState({
      mode: 'fields',
      text: '',
      fields: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
      ],
    });
    const down = panel.element.querySelector<HTMLButtonElement>(
      '[aria-label="Move field 1 down"]',
    )!;
    down.focus();
    down.click();
    expect(panel.state().fields.map((f) => f.key)).toEqual(['b', 'a']);
    // 'a' is last now, so its Down is disabled and focus goes to its Up.
    expect(document.activeElement).toBe(
      panel.element.querySelector('[aria-label="Move field 2 up"]'),
    );
  });

  it('round-trips the situation, blank rows included', () => {
    const state: StateDef = {
      mode: 'fields',
      text: 'kept',
      fields: [
        { key: 'tier', value: 'pro' },
        { key: '', value: '' },
        { key: 'note', value: 'multi\nline' },
      ],
    };
    panel.setState(state);
    expect(panel.state()).toEqual(state);
    panel.setState({ ...state, fields: [] });
    expect(panel.state().fields).toEqual([]);
    expect($$('dec-field')).toHaveLength(0);
  });

  it('refuses an empty text block and focuses it', () => {
    expect(panel.validate()).toBe(false);
    expect(invalid(promptField())).toBe(true);
    expect(document.activeElement).toBe(promptField());
    expect(panel.element.textContent).toContain('Describe the situation to decide on.');
    type(promptField(), 'Something');
    expect(invalid(promptField())).toBe(false);
    expect(panel.validate()).toBe(true);
  });

  it('refuses fields without a value, a value without a name, and a repeated name', () => {
    switchTo('fields');
    expect(panel.validate()).toBe(false);
    expect(panel.element.textContent).toContain('Add at least one field with a value.');

    panel.setState({
      mode: 'fields',
      text: '',
      fields: [
        { key: '', value: 'orphan' },
        { key: 'tier', value: 'a' },
        { key: 'tier', value: 'b' },
      ],
    });
    expect(panel.validate()).toBe(false);
    const keys = $$('dec-field-key');
    expect(invalid(keys[0]!)).toBe(true);
    expect(invalid(keys[2]!)).toBe(true);
    expect(invalid(keys[1]!)).toBe(false);
    expect(document.activeElement).toBe(keys[0]);
    expect(panel.element.textContent).toContain('Give this field a name.');
    expect(panel.element.textContent).toContain('“tier” is used by another field.');

    type(keys[0]!, 'first');
    type(keys[2]!, 'third');
    expect(panel.validate()).toBe(true);
    expect(invalid(keys[0]!)).toBe(false);
  });

  it('clears a field’s message as soon as the name is typed', () => {
    panel.setState({ mode: 'fields', text: '', fields: [{ key: '', value: 'orphan' }] });
    expect(panel.validate()).toBe(false);
    const key = $('dec-field-key') as HTMLInputElement;
    expect(invalid(key)).toBe(true);
    key.value = 'tier';
    key.dispatchEvent(new Event('input', { bubbles: true }));
    expect(invalid(key)).toBe(false);
  });

  it('does not check a field the user has not touched', () => {
    panel.setState({
      mode: 'fields',
      text: '',
      fields: [
        { key: 'tier', value: 'a' },
        { key: 'tier', value: 'b' },
      ],
    });
    expect($$('dec-field-key').every((key) => !invalid(key))).toBe(true);
  });
});
