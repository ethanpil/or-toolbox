import { afterEach, describe, expect, it, vi } from 'vitest';
import { schemaBuilder } from './builder';
import type { FieldDef } from './schema';

const fields: FieldDef[] = [
  { name: 'first', type: 'text', description: '', required: false },
  { name: 'second', type: 'text', description: '', required: false },
  {
    name: 'rows',
    type: 'table',
    description: '',
    required: false,
    columns: [
      { name: 'a', type: 'text', description: '' },
      { name: 'b', type: 'number', description: '' },
    ],
  },
];

afterEach(() => {
  document.body.replaceChildren();
});

const mount = () => {
  const builder = schemaBuilder({ onChange: vi.fn() });
  document.body.append(builder.element);
  builder.setFields(fields);
  return builder;
};
const button = (label: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

describe('schema builder', () => {
  it('refuses a name the response parser would drop, and keeps the old one', () => {
    const builder = mount();
    const input = document.querySelector<HTMLInputElement>('[aria-label="Name of field 1"]')!;
    input.value = 'Constructor';
    input.dispatchEvent(new Event('change'));
    expect(builder.fields()[0]?.name).toBe('first');
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(input.parentElement?.querySelector('.invalid-feedback')?.textContent).toMatch(
      /cannot be a name/,
    );
    input.value = 'Constructor name';
    input.dispatchEvent(new Event('change'));
    expect(builder.fields()[0]?.name).toBe('constructor_name');
  });

  it('keeps focus on the moved field when its move button becomes disabled', () => {
    const builder = mount();
    button('Move field second up').focus();
    button('Move field second up').click();
    expect(builder.fields().map((field) => field.name)).toEqual(['second', 'first', 'rows']);
    // "Up" is disabled at the top: focus goes to the same field's "Down".
    expect(button('Move field second up').disabled).toBe(true);
    expect(document.activeElement).toBe(button('Move field second down'));

    button('Move field first down').focus();
    button('Move field first down').click();
    expect(builder.fields().map((field) => field.name)).toEqual(['second', 'rows', 'first']);
    expect(document.activeElement).toBe(button('Move field first up'));
  });

  it('keeps focus on a moved column the same way', () => {
    mount();
    button('Move column b of rows up').focus();
    button('Move column b of rows up').click();
    expect(document.activeElement).toBe(button('Move column b of rows down'));
  });

  it('keeps focus on a field that moves but stays in the middle', () => {
    const builder = mount();
    builder.setFields([
      ...fields,
      { name: 'last', type: 'text', description: '', required: false },
    ]);
    button('Move field rows up').focus();
    button('Move field rows up').click();
    expect(document.activeElement).toBe(button('Move field rows up'));
  });
});
