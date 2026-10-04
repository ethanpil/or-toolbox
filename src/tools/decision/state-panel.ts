/**
 * The situation panel: what the model is asked to judge, as one text block (the default) or as key-value fields
 * that can be added, removed and reordered. Text mode sends a string and field mode an object. The text block is
 * the tool's main prompt field (`data-testid="tool-prompt"`); both modes keep their content while the other is in
 * use, so switching never loses anything.
 */
import { focusKey, h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { showListProblem, showProblem } from './invalid';
import {
  blankState,
  type FieldRow,
  moveBy,
  type StateDef,
  type StateMode,
  type StateProblem,
  validateState,
} from './schema';

export interface StatePanel {
  readonly element: HTMLElement;
  /** The main prompt field. */
  readonly text: HTMLTextAreaElement;
  state(): StateDef;
  setState(state: StateDef): void;
  /** Shows what is wrong at its field, focuses the first, and says whether the situation can be sent. */
  validate(): boolean;
}

interface Row extends FieldRow {
  rid: string;
}

export function statePanel(options: { onChange: () => void }): StatePanel {
  const ids = {
    group: uid('dec-mode'),
    text: uid('dec-text'),
    hint: uid('dec-text-hint'),
    name: uid('dec-mode-name'),
  };
  let mode: StateMode = 'text';
  let rows: Row[] = [];
  /** Fields the user has changed (or that failed a check): only these show their problems while editing. */
  const touched = new Set<string>();

  const makeRow = (row?: FieldRow): Row => ({ rid: uid('dec-field'), key: '', value: '', ...row });

  // --- mode ---------------------------------------------------------------------------------------------
  const radio = (value: StateMode, label: string, testId: string): HTMLElement[] => {
    const id = uid('dec-mode-radio');
    return [
      h('input', {
        id,
        type: 'radio',
        class: 'btn-check',
        name: ids.name,
        value,
        checked: value === 'text',
        'data-testid': testId,
        onchange: () => setMode(value),
      }),
      h('label', { class: 'btn btn-sm btn-outline-secondary', htmlFor: id }, label),
    ];
  };
  const modeGroup = h(
    'div',
    { class: 'btn-group', role: 'radiogroup', 'aria-labelledby': ids.group },
    radio('text', 'Text', 'dec-mode-text'),
    radio('fields', 'Key-value fields', 'dec-mode-fields'),
  );

  // --- text ---------------------------------------------------------------------------------------------
  const text = h('textarea', {
    id: ids.text,
    class: 'form-control',
    rows: 7,
    placeholder: 'Paste or write what you want a decision on: a ticket, a request, a post…',
    'aria-describedby': ids.hint,
    'data-testid': 'tool-prompt',
    oninput: () => {
      if (touched.has('text')) checkText();
      options.onChange();
    },
    onchange: () => {
      touched.add('text');
      checkText();
    },
  });
  const textFeedback = h('div', { class: 'invalid-feedback' });
  const textBox = h(
    'div',
    null,
    text,
    textFeedback,
    h(
      'div',
      { class: 'form-text', id: ids.hint },
      'You can also drop a .txt file anywhere on the page.',
    ),
  );

  // --- fields -------------------------------------------------------------------------------------------
  const list = h('ol', {
    class: 'list-unstyled vstack gap-2 mb-0',
    'aria-label': 'Fields',
    'data-testid': 'dec-fields',
  });
  const rowsProblem = h('div', {
    class: 'small text-danger-emphasis',
    role: 'alert',
    hidden: true,
  });
  const addField = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1',
      'data-focus-key': 'add-field',
      'data-testid': 'dec-add-field',
      onclick: () => {
        const row = makeRow();
        rows = [...rows, row];
        draw();
        options.onChange();
        focusKey(fieldsBox, `${row.rid}:key`);
      },
    },
    icon('plus-lg'),
    'Add field',
  );
  const fieldsBox = h(
    'div',
    { class: 'vstack gap-2' },
    list,
    rowsProblem,
    h('div', null, addField),
  );

  const keyEntries = new Map<string, { input: HTMLElement; feedback: HTMLElement }>();

  const iconButton = (
    label: string,
    name: string,
    key: string,
    onClick: () => void,
    disabled = false,
  ): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary',
        'aria-label': label,
        title: label,
        disabled,
        'data-focus-key': key,
        onclick: onClick,
      },
      icon(name),
    );

  const fieldRow = (row: Row, index: number): HTMLElement => {
    const where = `field ${index + 1}`;
    const feedback = h('div', { class: 'invalid-feedback' });
    const key = h('input', {
      type: 'text',
      class: 'form-control form-control-sm font-monospace',
      placeholder: 'Name, e.g. customer_tier',
      autocomplete: 'off',
      spellcheck: false,
      'aria-label': `Name of ${where}`,
      'data-focus-key': `${row.rid}:key`,
      'data-testid': 'dec-field-key',
      oninput: () => {
        row.key = key.value;
        if (touched.size > 0) checkFields();
        options.onChange();
      },
      onchange: () => {
        touched.add(row.rid);
        checkFields();
      },
      value: row.key,
    });
    keyEntries.set(row.rid, { input: key, feedback });
    const value = h('textarea', {
      class: 'form-control form-control-sm',
      rows: 2,
      placeholder: 'Value',
      'aria-label': `Value of ${where}`,
      'data-focus-key': `${row.rid}:value`,
      'data-testid': 'dec-field-value',
      oninput: () => {
        row.value = value.value;
        if (touched.size > 0) checkFields();
        options.onChange();
      },
      onchange: () => {
        touched.add(row.rid);
        checkFields();
      },
      value: row.value,
    });
    const moved = (keys: string[], message: string): void => {
      draw();
      options.onChange();
      announce(message);
      for (const k of keys) if (focusKey(fieldsBox, k)) return;
    };
    return h(
      'li',
      { class: 'border rounded p-2 vstack gap-2', 'data-testid': 'dec-field' },
      h(
        'div',
        { class: 'row g-2' },
        h('div', { class: 'col-12 col-sm-5' }, key, feedback),
        h('div', { class: 'col-12 col-sm-7' }, value),
      ),
      h(
        'div',
        { class: 'd-flex gap-1 justify-content-end' },
        iconButton(
          `Move ${where} up`,
          'arrow-up',
          `${row.rid}:up`,
          () => {
            rows = moveBy(rows, index, -1);
            moved(
              [`${row.rid}:up`, `${row.rid}:down`, `${row.rid}:key`],
              `Field moved up to position ${index}.`,
            );
          },
          index === 0,
        ),
        iconButton(
          `Move ${where} down`,
          'arrow-down',
          `${row.rid}:down`,
          () => {
            rows = moveBy(rows, index, 1);
            moved(
              [`${row.rid}:down`, `${row.rid}:up`, `${row.rid}:key`],
              `Field moved down to position ${index + 2}.`,
            );
          },
          index === rows.length - 1,
        ),
        iconButton(`Remove ${where}`, 'trash', `${row.rid}:remove`, () => {
          rows = rows.filter((other) => other !== row);
          draw();
          options.onChange();
          announce('Field removed.');
          const next = rows[Math.min(index, rows.length - 1)];
          focusKey(fieldsBox, next ? `${next.rid}:remove` : 'add-field');
        }),
      ),
    );
  };

  function draw(): void {
    keyEntries.clear();
    replace(
      list,
      rows.map((row, index) => fieldRow(row, index)),
    );
    if (mode === 'fields') checkFields();
  }

  // --- checking -----------------------------------------------------------------------------------------
  function problemsOf(): StateProblem[] {
    return validateState(panel.state());
  }

  function checkText(focus = false): void {
    const problem = mode === 'text' ? problemsOf().find((p) => p.field === 'text') : undefined;
    showProblem(text, textFeedback, problem?.message ?? null, { focus });
  }

  /** Shows the problems of fields the user has touched (all of them when `all`); returns the first shown. */
  function checkFields(all = false): StateProblem | undefined {
    const problems = mode === 'fields' ? problemsOf() : [];
    const rowsMessage = problems.find((p) => p.field === 'rows');
    if (all || touched.has('rows')) showListProblem(rowsProblem, rowsMessage?.message ?? null);
    else showListProblem(rowsProblem, null);
    for (const [index, row] of rows.entries()) {
      const entry = keyEntries.get(row.rid);
      if (!entry) continue;
      const problem = problems.find((p) => p.field === 'key' && p.row === index);
      showProblem(
        entry.input,
        entry.feedback,
        problem && (all || touched.has(row.rid)) ? problem.message : null,
      );
    }
    return problems[0];
  }

  // --- panel --------------------------------------------------------------------------------------------
  function setMode(next: StateMode): void {
    mode = next;
    for (const input of modeGroup.querySelectorAll('input')) input.checked = input.value === next;
    textBox.hidden = next !== 'text';
    fieldsBox.hidden = next !== 'fields';
    if (next === 'text') checkText();
    else checkFields();
    options.onChange();
  }

  const element = h(
    'section',
    { class: 'vstack gap-2', 'aria-labelledby': `${ids.group}-title`, 'data-testid': 'dec-state' },
    h(
      'div',
      { class: 'd-flex flex-wrap align-items-center gap-2' },
      h('h3', { id: `${ids.group}-title`, class: 'h6 mb-0 me-auto' }, 'Situation'),
      h('span', { id: ids.group, class: 'visually-hidden' }, 'How to describe the situation'),
      modeGroup,
    ),
    h('label', { class: 'visually-hidden', htmlFor: ids.text }, 'Situation to decide on'),
    textBox,
    fieldsBox,
  );
  fieldsBox.hidden = true;
  const panel: StatePanel = {
    element,
    text,
    state: () => ({
      mode,
      text: text.value,
      fields: rows.map(({ key, value }) => ({ key, value })),
    }),
    setState(state) {
      mode = state.mode;
      text.value = state.text;
      rows = state.fields.map((row) => makeRow(row));
      touched.clear();
      showProblem(text, textFeedback, null);
      showListProblem(rowsProblem, null);
      draw();
      for (const input of modeGroup.querySelectorAll('input')) input.checked = input.value === mode;
      textBox.hidden = mode !== 'text';
      fieldsBox.hidden = mode !== 'fields';
    },
    validate() {
      const problems = problemsOf();
      const first = problems[0];
      if (!first) {
        checkText();
        checkFields();
        return true;
      }
      touched.add('text');
      touched.add('rows');
      for (const row of rows) touched.add(row.rid);
      if (first.field === 'text') checkText(true);
      else {
        const target = first.row === undefined ? undefined : rows[first.row];
        checkFields(true);
        const entry = target ? keyEntries.get(target.rid) : undefined;
        if (entry) showProblem(entry.input, entry.feedback, first.message, { focus: true });
        else focusKey(fieldsBox, 'add-field');
      }
      return false;
    },
  };
  panel.setState(blankState());
  return panel;
}
