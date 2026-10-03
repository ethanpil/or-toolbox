/**
 * The visual schema builder: a list of fields, each with a name, a type, a description for the model and a
 * Required box; choices for a Choice field and columns for a table of line items. Fields and columns move
 * with Up/Down buttons (no drag-only interaction), and every control keeps focus across redraws.
 */
import { h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { setFieldError } from '../../ui/feedback/field-error';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import {
  COLUMN_TYPES,
  type ColumnDef,
  type ColumnType,
  cleanFields,
  FIELD_TYPES,
  type FieldDef,
  type FieldType,
  fieldLabel,
  normalizeFieldName,
  TYPE_LABELS,
  validateSchema,
} from './schema';

export interface SchemaBuilder {
  readonly element: HTMLElement;
  /** A clean copy of the fields. */
  fields(): FieldDef[];
  setFields(fields: readonly FieldDef[]): void;
  /** Shows the first problem at its field and returns false when the schema cannot be used. */
  validate(): boolean;
}

interface Row {
  id: string;
  field: FieldDef;
  columnIds: string[];
}

/** Moves an item one place up (-1) or down (+1). */
export function move<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** A name not used yet: `field`, `field_2`, `field_3`… */
export function freeName(base: string, taken: readonly string[]): string {
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}_${n}`;
  return name;
}

export function schemaBuilder(options: { onChange: () => void }): SchemaBuilder {
  let rows: Row[] = [];
  const list = h('ol', {
    class: 'list-unstyled vstack gap-2 mb-0',
    'aria-label': 'Fields',
    'data-testid': 'de-fields',
  });
  const problem = h('div', { class: 'small text-danger-emphasis', role: 'alert', hidden: true });

  const changed = (): void => {
    problem.hidden = true;
    options.onChange();
  };

  const iconButton = (
    label: string,
    name: string,
    focusKey: string,
    onClick: () => void,
    disabled = false,
    testId?: string,
  ): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary',
        'aria-label': label,
        title: label,
        disabled,
        'data-focus-key': focusKey,
        ...(testId ? { 'data-testid': testId } : {}),
        onclick: onClick,
      },
      icon(name),
    );

  const nameInput = (
    value: string,
    label: string,
    focusKey: string,
    taken: () => string[],
    apply: (name: string) => void,
    testId: string,
  ): HTMLElement => {
    const feedback = h('div', { class: 'invalid-feedback' });
    const input = h('input', {
      type: 'text',
      class: 'form-control form-control-sm font-monospace',
      value,
      'aria-label': label,
      autocomplete: 'off',
      spellcheck: false,
      'data-focus-key': focusKey,
      'data-testid': testId,
      onchange: () => {
        const name = normalizeFieldName(input.value);
        if (!name) {
          setFieldError(input, feedback, 'Give it a name with letters or digits.');
          return;
        }
        if (taken().includes(name)) {
          setFieldError(input, feedback, `“${name}” is already used.`);
          return;
        }
        setFieldError(input, feedback, null);
        input.value = name;
        apply(name);
        changed();
      },
    });
    return h('div', { class: 'flex-grow-1 or-schema-name' }, input, feedback);
  };

  const columnEditor = (row: Row, column: ColumnDef, index: number): HTMLElement => {
    const columns = row.field.columns ?? [];
    const columnId = row.columnIds[index]!;
    const where = `column ${column.name} of ${row.field.name}`;
    const type = h(
      'select',
      {
        class: 'form-select form-select-sm w-auto',
        'aria-label': `Type of ${where}`,
        'data-focus-key': `ctype:${columnId}`,
        onchange: () => {
          column.type = type.value as ColumnType;
          changed();
        },
      },
      COLUMN_TYPES.map((value) => h('option', { value }, TYPE_LABELS[value])),
    );
    type.value = column.type;
    const description = h('input', {
      type: 'text',
      class: 'form-control form-control-sm',
      value: column.description,
      placeholder: 'What goes in this column',
      'aria-label': `Description of ${where}`,
      'data-focus-key': `cdesc:${columnId}`,
      oninput: () => {
        column.description = description.value;
        changed();
      },
    });
    return h(
      'li',
      { class: 'vstack gap-1', 'data-testid': 'de-column' },
      h(
        'div',
        { class: 'd-flex flex-wrap gap-1 align-items-start' },
        nameInput(
          column.name,
          `Name of ${where}`,
          `cname:${columnId}`,
          () => columns.filter((other) => other !== column).map((other) => other.name),
          (name) => {
            column.name = name;
            draw();
          },
          'de-column-name',
        ),
        type,
        iconButton(
          `Move ${where} up`,
          'arrow-up',
          `cup:${columnId}`,
          () => {
            row.field.columns = move(columns, index, -1);
            row.columnIds = move(row.columnIds, index, -1);
            draw();
            changed();
            focusMoved([`cup:${columnId}`, `cdown:${columnId}`, `cname:${columnId}`]);
          },
          index === 0,
        ),
        iconButton(
          `Move ${where} down`,
          'arrow-down',
          `cdown:${columnId}`,
          () => {
            row.field.columns = move(columns, index, 1);
            row.columnIds = move(row.columnIds, index, 1);
            draw();
            changed();
            focusMoved([`cdown:${columnId}`, `cup:${columnId}`, `cname:${columnId}`]);
          },
          index === columns.length - 1,
        ),
        iconButton(`Remove ${where}`, 'x-lg', `cremove:${columnId}`, () => {
          row.field.columns = columns.filter((_, i) => i !== index);
          row.columnIds = row.columnIds.filter((_, i) => i !== index);
          draw();
          changed();
          announce(`Column ${column.name} removed.`);
          focusLater(`addcol:${row.id}`);
        }),
      ),
      description,
    );
  };

  const fieldEditor = (row: Row, index: number): HTMLElement => {
    const { field } = row;
    const where = `field ${field.name}`;
    const type = h(
      'select',
      {
        class: 'form-select form-select-sm w-auto',
        'aria-label': `Type of ${where}`,
        'data-focus-key': `type:${row.id}`,
        'data-testid': 'de-field-type',
        onchange: () => {
          field.type = type.value as FieldType;
          if (field.type === 'enum' && !field.options) field.options = [];
          if (field.type === 'table' && !field.columns?.length) {
            field.columns = [{ name: 'description', type: 'text', description: '' }];
            row.columnIds = [uid('col')];
          }
          draw();
          changed();
        },
      },
      FIELD_TYPES.map((value) => h('option', { value }, TYPE_LABELS[value])),
    );
    type.value = field.type;
    const requiredId = uid('required');
    const required = h('input', {
      id: requiredId,
      type: 'checkbox',
      class: 'form-check-input',
      checked: field.required,
      'data-focus-key': `required:${row.id}`,
      onchange: () => {
        field.required = required.checked;
        changed();
      },
    });
    const description = h('input', {
      type: 'text',
      class: 'form-control form-control-sm',
      value: field.description,
      placeholder: 'What to look for (the model reads this)',
      'aria-label': `Description of ${where}`,
      'data-focus-key': `desc:${row.id}`,
      oninput: () => {
        field.description = description.value;
        changed();
      },
    });
    const extra: HTMLElement[] = [];
    if (field.type === 'enum') {
      const choices = h('input', {
        type: 'text',
        class: 'form-control form-control-sm',
        value: (field.options ?? []).join(', '),
        placeholder: 'Choices, separated by commas',
        'aria-label': `Choices of ${where}, separated by commas`,
        'data-focus-key': `options:${row.id}`,
        onchange: () => {
          field.options = [
            ...new Set(
              choices.value
                .split(',')
                .map((option) => option.trim())
                .filter(Boolean),
            ),
          ];
          choices.value = field.options.join(', ');
          changed();
        },
      });
      extra.push(choices);
    }
    if (field.type === 'table') {
      const columns = field.columns ?? [];
      extra.push(
        h(
          'div',
          { class: 'ps-3 border-start vstack gap-2' },
          h('div', { class: 'small fw-semibold' }, 'Columns'),
          h(
            'ol',
            { class: 'list-unstyled vstack gap-2 mb-0', 'aria-label': `Columns of ${field.name}` },
            columns.map((column, c) => columnEditor(row, column, c)),
          ),
          h(
            'div',
            null,
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
                'data-focus-key': `addcol:${row.id}`,
                'data-testid': 'de-add-column',
                onclick: () => {
                  const name = freeName(
                    'column',
                    columns.map((column) => column.name),
                  );
                  field.columns = [...columns, { name, type: 'text', description: '' }];
                  const id = uid('col');
                  row.columnIds = [...row.columnIds, id];
                  draw();
                  changed();
                  focusLater(`cname:${id}`);
                },
              },
              icon('plus-lg'),
              'Add column',
            ),
          ),
        ),
      );
    }
    return h(
      'li',
      {
        class: 'border rounded p-2 vstack gap-2 or-schema-field',
        'data-testid': 'de-field',
        dataset: { field: field.name },
      },
      h(
        'div',
        { class: 'd-flex flex-wrap gap-1 align-items-start' },
        nameInput(
          field.name,
          `Name of field ${index + 1}`,
          `name:${row.id}`,
          () => rows.filter((other) => other !== row).map((other) => other.field.name),
          (name) => {
            field.name = name;
            draw();
          },
          'de-field-name',
        ),
        type,
        h(
          'div',
          { class: 'form-check form-check-inline m-0 ms-1 align-self-center' },
          required,
          h('label', { class: 'form-check-label small', htmlFor: requiredId }, 'Required'),
        ),
        iconButton(
          `Move ${where} up`,
          'arrow-up',
          `up:${row.id}`,
          () => {
            rows = move(rows, index, -1);
            draw();
            changed();
            announce(`${fieldLabel(field.name)} moved up.`);
            focusMoved([`up:${row.id}`, `down:${row.id}`, `name:${row.id}`]);
          },
          index === 0,
          'de-field-up',
        ),
        iconButton(
          `Move ${where} down`,
          'arrow-down',
          `down:${row.id}`,
          () => {
            rows = move(rows, index, 1);
            draw();
            changed();
            announce(`${fieldLabel(field.name)} moved down.`);
            focusMoved([`down:${row.id}`, `up:${row.id}`, `name:${row.id}`]);
          },
          index === rows.length - 1,
          'de-field-down',
        ),
        iconButton(
          `Remove ${where}`,
          'trash',
          `remove:${row.id}`,
          () => {
            rows = rows.filter((other) => other !== row);
            draw();
            changed();
            announce(`${fieldLabel(field.name)} removed.`);
            const next = rows[Math.min(index, rows.length - 1)];
            focusLater(next ? `remove:${next.id}` : 'add-field');
          },
          false,
          'de-field-remove',
        ),
      ),
      description,
      extra,
    );
  };

  const addButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1',
      'data-focus-key': 'add-field',
      'data-testid': 'de-add-field',
      onclick: () => {
        const name = freeName(
          'field',
          rows.map((row) => row.field.name),
        );
        const row: Row = {
          id: uid('field'),
          field: { name, type: 'text', description: '', required: false },
          columnIds: [],
        };
        rows = [...rows, row];
        draw();
        changed();
        focusLater(`name:${row.id}`);
      },
    },
    icon('plus-lg'),
    'Add field',
  );

  const element = h('div', { class: 'vstack gap-2' }, list, problem, h('div', null, addButton));

  /**
   * After a move, keeps focus on the moved field (or column): on the button pressed if it still works, else on
   * its other move button (Up is disabled at the top), else on its name.
   */
  function focusMoved(keys: readonly string[]): void {
    for (const key of keys) {
      const target = [...element.querySelectorAll<HTMLElement>('[data-focus-key]')].find(
        (candidate) => candidate.getAttribute('data-focus-key') === key,
      );
      if (target && !(target instanceof HTMLButtonElement && target.disabled)) {
        target.focus();
        return;
      }
    }
  }

  /** Focuses a control by its focus key after a redraw. */
  function focusLater(key: string): void {
    [...element.querySelectorAll<HTMLElement>('[data-focus-key]')]
      .find((candidate) => candidate.getAttribute('data-focus-key') === key)
      ?.focus();
  }

  function draw(): void {
    replace(
      list,
      rows.map((row, index) => fieldEditor(row, index)),
    );
  }

  const toRows = (fields: readonly FieldDef[]): Row[] =>
    cleanFields(fields).map((field) => ({
      id: uid('field'),
      field,
      columnIds: (field.columns ?? []).map(() => uid('col')),
    }));

  return {
    element,
    fields: () => cleanFields(rows.map((row) => row.field)),
    setFields(fields) {
      rows = toRows(fields);
      problem.hidden = true;
      draw();
    },
    validate() {
      const problems = validateSchema(rows.map((row) => row.field));
      const first = problems[0];
      if (!first) {
        problem.hidden = true;
        return true;
      }
      problem.hidden = false;
      problem.textContent =
        first.index >= 0
          ? `${fieldLabel(rows[first.index]?.field.name || `Field ${first.index + 1}`)}: ${first.message}`
          : first.message;
      const row = rows[first.index];
      focusLater(row ? `name:${row.id}` : 'add-field');
      return false;
    },
  };
}
