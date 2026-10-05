/**
 * The question builder: any number of question cards, each with a short name (the id on the wire is a slug of it,
 * unique and editable), instructions, a type and a threshold, and the part its type needs: criteria for Yes and
 * No, named options, or an ordered scale of levels. Options and levels move with Move up and Move down buttons;
 * levels can also be dragged (the buttons are the keyboard route, so nothing needs a pointer).
 *
 * The form holds every question's Yes/No criteria, options and levels at once and only the active type's reach
 * the request, so switching a question's type loses nothing. Typing updates the model in place (focus and caret
 * stay); adding, removing, moving and type changes redraw the list and give focus back by `data-focus-key`.
 *
 * Problems are shown at their field through `setFieldError`, but only for fields the user has changed or that
 * failed a Run (`touched`), so a fresh card is not scolded for being empty.
 */
import { focusKey, h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { showListProblem, showProblem } from './invalid';
import {
  blankQuestion,
  DEFAULT_THRESHOLD,
  isDerivedId,
  moveBy,
  moveTo,
  type Problem,
  type ProblemField,
  type QuestionDef,
  QUESTION_TYPES,
  type QuestionType,
  slugify,
  thresholdOf,
  TYPE_LABELS,
  uniqueId,
  validateQuestions,
} from './schema';

export interface QuestionBuilder {
  readonly element: HTMLElement;
  /** A clean copy of the questions as the form holds them (thresholds read, ids without surrounding spaces). */
  questions(): QuestionDef[];
  /**
   * One key per question, in the order of `questions()`, that stays with its card through renames (the id
   * changes with the name; the key never does). Answers drawn for a run are matched to thresholds by it.
   */
  keys(): string[];
  /** The threshold now set for each question, by key. */
  thresholds(): Map<string, number>;
  setQuestions(questions: readonly QuestionDef[]): void;
  /** Shows every problem at its field and focuses the first; false when the questions cannot be sent. */
  validate(): boolean;
}

interface OptionRow {
  rid: string;
  name: string;
  description: string;
}

interface LevelRow {
  rid: string;
  text: string;
}

interface QuestionRow {
  rid: string;
  name: string;
  id: string;
  /** The user typed the id: renaming the question leaves it alone. */
  idEdited: boolean;
  instructions: string;
  type: QuestionType;
  /** As typed, so an invalid entry can be shown and refused rather than silently replaced. */
  threshold: string;
  yes: string;
  no: string;
  options: OptionRow[];
  levels: LevelRow[];
}

interface Entry {
  input: HTMLElement;
  feedback: HTMLElement;
}

/** The drag's own data type (never text/plain, which a text field would take in). */
const DRAG_TYPE = 'application/x-ortoolbox-level';

const parseThreshold = (text: string): number => (text.trim() === '' ? NaN : Number(text));

export function questionBuilder(options: {
  onChange: () => void;
  /** The threshold a new question starts with. */
  defaultThreshold?: () => number;
}): QuestionBuilder {
  let rows: QuestionRow[] = [];
  /** Keys of fields whose problems may show (see the file comment). */
  const touched = new Set<string>();
  /** Inputs of the cards on screen, by problem key (rebuilt on every draw). */
  let entries = new Map<string, Entry>();
  let alerts = new Map<string, HTMLElement>();
  let adders = new Map<string, HTMLElement>();

  const list = h('ol', {
    class: 'list-unstyled vstack gap-3 mb-0',
    'aria-label': 'Questions',
    'data-testid': 'dec-questions',
  });
  const formProblem = h('div', {
    class: 'small text-danger-emphasis',
    role: 'alert',
    hidden: true,
  });
  const element = h('div', { class: 'vstack gap-3' }, list, formProblem);

  /** The model changed: problems already on show are re-checked as the user types (fixed ones clear at once). */
  const changed = (): void => {
    if (touched.size > 0) showTouched();
    options.onChange();
  };

  // --- model --------------------------------------------------------------------------------------------
  const toDef = (row: QuestionRow): QuestionDef => ({
    name: row.name,
    // As the request will name it: the field may still hold a trailing space the user has not left yet.
    id: row.id.trim(),
    instructions: row.instructions,
    type: row.type,
    threshold: thresholdOf(parseThreshold(row.threshold)),
    yes: row.yes,
    no: row.no,
    options: row.options.map(({ name, description }) => ({ name, description })),
    levels: row.levels.map((level) => level.text),
  });

  const toRow = (def: QuestionDef, taken: readonly string[]): QuestionRow => {
    const named = def.name.trim() !== '';
    return {
      rid: uid('dec-q'),
      name: def.name,
      id: def.id.trim() || (named ? uniqueId(slugify(def.name), taken) : ''),
      idEdited: def.id.trim() !== '' && !isDerivedId(def.id.trim(), def.name),
      instructions: def.instructions,
      type: def.type,
      threshold: String(def.threshold),
      yes: def.yes,
      no: def.no,
      options: def.options.map((option) => ({ rid: uid('dec-o'), ...option })),
      levels: def.levels.map((text) => ({ rid: uid('dec-l'), text })),
    };
  };

  const idsExcept = (row: QuestionRow): string[] =>
    rows.filter((other) => other !== row).map((other) => other.id.trim());

  // --- problems -----------------------------------------------------------------------------------------
  /** The problem key of a field: `<question>:<field>`, with the option or level for those. */
  function keyOf(problem: Problem): string {
    const row = rows[problem.question];
    if (!row) return 'questions';
    if (problem.field === 'option')
      return `${row.rid}:option:${row.options[problem.item ?? 0]?.rid}`;
    if (problem.field === 'level') return `${row.rid}:level:${row.levels[problem.item ?? 0]?.rid}`;
    return `${row.rid}:${problem.field}`;
  }

  /** The pure problems plus a threshold that is not a number from 0 to 100 as typed. */
  function allProblems(): Problem[] {
    const problems = validateQuestions(rows.map(toDef));
    rows.forEach((row, question) => {
      const value = parseThreshold(row.threshold);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        problems.push({
          question,
          field: 'threshold',
          message: 'Use a percentage from 0 to 100.',
        });
      }
    });
    const order: ProblemField[] = [
      'questions',
      'name',
      'id',
      'instructions',
      'threshold',
      'yes',
      'no',
      'options',
      'option',
      'levels',
      'level',
    ];
    return problems.sort(
      (a, b) =>
        a.question - b.question ||
        order.indexOf(a.field) - order.indexOf(b.field) ||
        (a.item ?? 0) - (b.item ?? 0),
    );
  }

  /** Shows the problems of touched fields and clears every other message. */
  function showTouched(): void {
    const messages = new Map<string, string>();
    for (const problem of allProblems()) {
      const key = keyOf(problem);
      if (touched.has(key) && !messages.has(key)) messages.set(key, problem.message);
    }
    for (const [key, entry] of entries) {
      showProblem(entry.input, entry.feedback, messages.get(key) ?? null);
    }
    for (const [key, alert] of alerts) showListProblem(alert, messages.get(key) ?? null);
    showListProblem(formProblem, messages.get('questions') ?? null);
  }

  const touch = (key: string): void => {
    touched.add(key);
    showTouched();
  };

  // --- field pieces -------------------------------------------------------------------------------------
  /** A labelled control with its feedback, registered under `key` for problems. */
  function field(
    key: string,
    label: string,
    control: HTMLElement,
    extra?: { help?: string; group?: HTMLElement[] },
  ): HTMLElement {
    const feedback = h('div', { class: 'invalid-feedback' });
    entries.set(key, { input: control, feedback });
    const helpId = extra?.help ? uid('dec-help') : undefined;
    if (helpId) control.setAttribute('aria-describedby', helpId);
    return h(
      'div',
      null,
      h('label', { class: 'form-label small fw-semibold mb-1', htmlFor: control.id }, label),
      extra?.group
        ? h(
            'div',
            { class: 'input-group input-group-sm has-validation' },
            control,
            extra.group,
            feedback,
          )
        : [control, feedback],
      extra?.help && h('div', { class: 'form-text mt-1', id: helpId }, extra.help),
    );
  }

  const textInput = (
    row: QuestionRow,
    prop: 'name' | 'instructions' | 'yes' | 'no',
    attrs: { focus: string; testId: string; placeholder?: string; multiline?: boolean },
    after?: (value: string) => void,
  ): HTMLInputElement | HTMLTextAreaElement => {
    const key = `${row.rid}:${prop}`;
    const common = {
      id: uid('dec-in'),
      class: 'form-control form-control-sm',
      placeholder: attrs.placeholder ?? '',
      'data-focus-key': attrs.focus,
      'data-testid': attrs.testId,
    };
    const apply = (value: string): void => {
      row[prop] = value;
      after?.(value);
      changed();
    };
    if (attrs.multiline) {
      const area = h('textarea', {
        ...common,
        rows: 2,
        oninput: () => apply(area.value),
        onchange: () => touch(key),
        value: row[prop],
      });
      return area;
    }
    const input = h('input', {
      ...common,
      type: 'text',
      autocomplete: 'off',
      oninput: () => apply(input.value),
      onchange: () => touch(key),
      value: row[prop],
    });
    return input;
  };

  const iconButton = (
    label: string,
    name: string,
    key: string,
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
        'data-focus-key': key,
        ...(testId ? { 'data-testid': testId } : {}),
        onclick: onClick,
      },
      icon(name),
    );

  /** After a move: focus stays on the button pressed if it still works, else on its twin, else the text. */
  const focusMoved = (keys: readonly string[]): void => {
    for (const key of keys) if (focusKey(element, key)) return;
  };

  const listAlert = (key: string): HTMLElement => {
    const alert = h('div', { class: 'small text-danger-emphasis', role: 'alert', hidden: true });
    alerts.set(key, alert);
    return alert;
  };

  // --- yes/no -------------------------------------------------------------------------------------------
  const noulFields = (row: QuestionRow): HTMLElement =>
    h(
      'div',
      { class: 'vstack gap-2' },
      field(
        `${row.rid}:yes`,
        'Criteria for Yes (optional)',
        textInput(row, 'yes', {
          focus: `${row.rid}:yes`,
          testId: 'dec-yes',
          placeholder: 'What makes the answer yes',
          multiline: true,
        }),
        { help: 'Fill in both criteria, or neither.' },
      ),
      field(
        `${row.rid}:no`,
        'Criteria for No (optional)',
        textInput(row, 'no', {
          focus: `${row.rid}:no`,
          testId: 'dec-no',
          placeholder: 'What makes the answer no',
          multiline: true,
        }),
      ),
    );

  // --- choice -------------------------------------------------------------------------------------------
  const optionRow = (row: QuestionRow, option: OptionRow, index: number): HTMLElement => {
    const where = `option ${index + 1} of ${row.name.trim() || 'the question'}`;
    const nameKey = `${row.rid}:option:${option.rid}`;
    const feedback = h('div', { class: 'invalid-feedback' });
    const name = h('input', {
      type: 'text',
      class: 'form-control form-control-sm',
      placeholder: 'Option name',
      autocomplete: 'off',
      'aria-label': `Name of ${where}`,
      'data-focus-key': `${option.rid}:name`,
      'data-testid': 'dec-option-name',
      oninput: () => {
        option.name = name.value;
        changed();
      },
      onchange: () => touch(nameKey),
      value: option.name,
    });
    entries.set(nameKey, { input: name, feedback });
    const description = h('input', {
      type: 'text',
      class: 'form-control form-control-sm',
      placeholder: 'Description (optional)',
      autocomplete: 'off',
      'aria-label': `Description of ${where}`,
      'data-focus-key': `${option.rid}:description`,
      'data-testid': 'dec-option-description',
      oninput: () => {
        option.description = description.value;
        changed();
      },
      value: option.description,
    });
    const moved = (keys: string[], message: string): void => {
      draw();
      changed();
      announce(message);
      focusMoved(keys);
    };
    return h(
      'li',
      { class: 'row g-1 align-items-start', 'data-testid': 'dec-option' },
      h('div', { class: 'col-12 col-md-4' }, name, feedback),
      h('div', { class: 'col-12 col-md' }, description),
      h(
        'div',
        { class: 'col-auto d-flex gap-1' },
        iconButton(
          `Move ${where} up`,
          'arrow-up',
          `${option.rid}:up`,
          () => {
            row.options = moveBy(row.options, index, -1);
            moved(
              [`${option.rid}:up`, `${option.rid}:down`, `${option.rid}:name`],
              `Option moved up to position ${index}.`,
            );
          },
          index === 0,
          'dec-option-up',
        ),
        iconButton(
          `Move ${where} down`,
          'arrow-down',
          `${option.rid}:down`,
          () => {
            row.options = moveBy(row.options, index, 1);
            moved(
              [`${option.rid}:down`, `${option.rid}:up`, `${option.rid}:name`],
              `Option moved down to position ${index + 2}.`,
            );
          },
          index === row.options.length - 1,
          'dec-option-down',
        ),
        iconButton(
          `Remove ${where}`,
          'x-lg',
          `${option.rid}:remove`,
          () => {
            row.options = row.options.filter((other) => other !== option);
            draw();
            changed();
            announce('Option removed.');
            const next = row.options[Math.min(index, row.options.length - 1)];
            focusKey(element, next ? `${next.rid}:remove` : `${row.rid}:add-option`);
          },
          false,
          'dec-option-remove',
        ),
      ),
    );
  };

  const choiceFields = (row: QuestionRow): HTMLElement => {
    const add = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
        'data-focus-key': `${row.rid}:add-option`,
        'data-testid': 'dec-add-option',
        onclick: () => {
          const option: OptionRow = { rid: uid('dec-o'), name: '', description: '' };
          row.options = [...row.options, option];
          draw();
          changed();
          announce(`Option ${row.options.length} added.`);
          focusKey(element, `${option.rid}:name`);
        },
      },
      icon('plus-lg'),
      'Add option',
    );
    adders.set(`${row.rid}:options`, add);
    return h(
      'div',
      { class: 'vstack gap-2' },
      h('div', { class: 'small fw-semibold' }, 'Options'),
      h(
        'ol',
        { class: 'list-unstyled vstack gap-2 mb-0', 'aria-label': 'Options' },
        row.options.map((option, index) => optionRow(row, option, index)),
      ),
      listAlert(`${row.rid}:options`),
      h('div', null, add),
    );
  };

  // --- score --------------------------------------------------------------------------------------------
  /** The level being dragged. */
  let dragging: { question: string; level: string } | null = null;
  const clearDrop = (): void => {
    for (const el of element.querySelectorAll('.or-dec-drop-before, .or-dec-drop-after')) {
      el.classList.remove('or-dec-drop-before', 'or-dec-drop-after');
    }
  };

  const levelRow = (row: QuestionRow, level: LevelRow, index: number): HTMLElement => {
    const where = `level ${index} of ${row.name.trim() || 'the question'}`;
    const levelKey = `${row.rid}:level:${level.rid}`;
    const feedback = h('div', { class: 'invalid-feedback' });
    const text = h('input', {
      type: 'text',
      class: 'form-control form-control-sm',
      placeholder: index === 0 ? 'The lowest level' : 'Describe this level',
      autocomplete: 'off',
      'aria-label': `Description of ${where}`,
      'data-focus-key': `${level.rid}:text`,
      'data-testid': 'dec-level-text',
      oninput: () => {
        level.text = text.value;
        changed();
      },
      onchange: () => touch(levelKey),
      value: level.text,
    });
    entries.set(levelKey, { input: text, feedback });
    const moved = (keys: string[], message: string): void => {
      draw();
      changed();
      announce(message);
      focusMoved(keys);
    };
    const handle = h(
      'span',
      {
        class: 'or-dec-handle',
        draggable: true,
        'aria-hidden': 'true',
        title: 'Drag to reorder (or use the Move buttons)',
        'data-testid': 'dec-level-handle',
        ondragstart: (event: DragEvent) => {
          dragging = { question: row.rid, level: level.rid };
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            // A type of its own: with text/plain, dropping the handle on a text field would type the row's id.
            event.dataTransfer.setData(DRAG_TYPE, level.rid);
            event.dataTransfer.setDragImage(item, 16, 16);
          }
          item.classList.add('or-dec-dragging');
        },
        ondragend: () => {
          dragging = null;
          item.classList.remove('or-dec-dragging');
          clearDrop();
        },
      },
      icon('grip-vertical'),
    );
    const item = h(
      'li',
      {
        class: 'or-dec-level',
        'data-testid': 'dec-level',
        ondragover: (event: DragEvent) => {
          if (dragging?.question !== row.rid) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          const box = item.getBoundingClientRect();
          const after = event.clientY > box.top + box.height / 2;
          clearDrop();
          item.classList.add(after ? 'or-dec-drop-after' : 'or-dec-drop-before');
        },
        ondragleave: (event: DragEvent) => {
          if (!item.contains(event.relatedTarget as Node | null)) {
            item.classList.remove('or-dec-drop-before', 'or-dec-drop-after');
          }
        },
        ondrop: (event: DragEvent) => {
          if (dragging?.question !== row.rid) return;
          event.preventDefault();
          // The drag is over. The redraw below replaces the dragged node, so its dragend may never come.
          const draggedRid = dragging.level;
          dragging = null;
          const from = row.levels.findIndex((other) => other.rid === draggedRid);
          const after = item.classList.contains('or-dec-drop-after');
          clearDrop();
          if (from < 0) return;
          // The slot between the rows, then the index the dragged level ends up at once it is lifted out.
          let to = after ? index + 1 : index;
          if (from < to) to -= 1;
          if (to === from) return;
          row.levels = moveTo(row.levels, from, to);
          moved([`${draggedRid}:text`], `Level moved to position ${to}.`);
        },
      },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-start gap-1' },
        handle,
        h('span', { class: 'or-dec-level-index', 'aria-hidden': 'true' }, String(index)),
        h('div', { class: 'flex-grow-1 or-dec-level-field' }, text, feedback),
        h(
          'div',
          { class: 'd-flex gap-1' },
          iconButton(
            `Move ${where} up`,
            'arrow-up',
            `${level.rid}:up`,
            () => {
              row.levels = moveBy(row.levels, index, -1);
              moved(
                [`${level.rid}:up`, `${level.rid}:down`, `${level.rid}:text`],
                `Level moved up to position ${index - 1}.`,
              );
            },
            index === 0,
            'dec-level-up',
          ),
          iconButton(
            `Move ${where} down`,
            'arrow-down',
            `${level.rid}:down`,
            () => {
              row.levels = moveBy(row.levels, index, 1);
              moved(
                [`${level.rid}:down`, `${level.rid}:up`, `${level.rid}:text`],
                `Level moved down to position ${index + 1}.`,
              );
            },
            index === row.levels.length - 1,
            'dec-level-down',
          ),
          iconButton(
            `Remove ${where}`,
            'x-lg',
            `${level.rid}:remove`,
            () => {
              row.levels = row.levels.filter((other) => other !== level);
              draw();
              changed();
              announce('Level removed.');
              const next = row.levels[Math.min(index, row.levels.length - 1)];
              focusKey(element, next ? `${next.rid}:remove` : `${row.rid}:add-level`);
            },
            false,
            'dec-level-remove',
          ),
        ),
      ),
    );
    return item;
  };

  const scoreFields = (row: QuestionRow): HTMLElement => {
    const add = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
        'data-focus-key': `${row.rid}:add-level`,
        'data-testid': 'dec-add-level',
        onclick: () => {
          const level: LevelRow = { rid: uid('dec-l'), text: '' };
          row.levels = [...row.levels, level];
          draw();
          changed();
          announce(`Level ${row.levels.length - 1} added.`);
          focusKey(element, `${level.rid}:text`);
        },
      },
      icon('plus-lg'),
      'Add level',
    );
    adders.set(`${row.rid}:levels`, add);
    return h(
      'div',
      { class: 'vstack gap-2' },
      h(
        'div',
        null,
        h('div', { class: 'small fw-semibold' }, 'Scale, lowest level first'),
        h(
          'div',
          { class: 'form-text mt-0' },
          'Levels are numbered from 0. The score is a position on this scale: 1.99 is almost level 2.',
        ),
      ),
      h(
        'ol',
        { class: 'list-unstyled vstack gap-2 mb-0', 'aria-label': 'Levels' },
        row.levels.map((level, index) => levelRow(row, level, index)),
      ),
      listAlert(`${row.rid}:levels`),
      h('div', null, add),
    );
  };

  // --- question card ------------------------------------------------------------------------------------
  const questionCard = (row: QuestionRow, index: number): HTMLElement => {
    const titleId = uid('dec-q-title');
    const name = textInput(
      row,
      'name',
      { focus: `${row.rid}:name`, testId: 'dec-name', placeholder: 'For example: Is it a bug?' },
      () => {
        if (row.idEdited) return;
        row.id = row.name.trim() ? uniqueId(slugify(row.name), idsExcept(row)) : '';
        idInput.value = row.id;
        if (touched.has(`${row.rid}:id`)) showTouched();
      },
    );
    const idInput = h('input', {
      id: uid('dec-in'),
      type: 'text',
      class: 'form-control form-control-sm font-monospace',
      placeholder: 'Made from the name',
      autocomplete: 'off',
      spellcheck: false,
      'data-focus-key': `${row.rid}:id`,
      'data-testid': 'dec-id',
      oninput: () => {
        row.id = idInput.value;
        row.idEdited = true;
        changed();
      },
      onchange: () => {
        const typed = slugify(idInput.value);
        if (typed === '') {
          // Emptied: back to following the name.
          row.idEdited = false;
          row.id = row.name.trim() ? uniqueId(slugify(row.name), idsExcept(row)) : '';
        } else {
          row.id = typed;
        }
        idInput.value = row.id;
        changed();
        touch(`${row.rid}:id`);
      },
      value: row.id,
    });
    const type = h(
      'select',
      {
        id: uid('dec-in'),
        class: 'form-select form-select-sm',
        'data-focus-key': `${row.rid}:type`,
        'data-testid': 'dec-type',
        onchange: () => {
          row.type = type.value as QuestionType;
          draw();
          changed();
          announce(`Question type: ${TYPE_LABELS[row.type]}.`);
        },
      },
      QUESTION_TYPES.map((value) => h('option', { value }, TYPE_LABELS[value])),
    );
    type.value = row.type;
    const thresholdKey = `${row.rid}:threshold`;
    const threshold = h('input', {
      id: uid('dec-in'),
      type: 'number',
      class: 'form-control form-control-sm',
      min: '0',
      max: '100',
      step: '1',
      inputMode: 'decimal',
      'data-focus-key': thresholdKey,
      'data-testid': 'dec-threshold',
      oninput: () => {
        row.threshold = threshold.value;
        if (touched.has(thresholdKey)) showTouched();
        changed();
      },
      onchange: () => {
        const value = parseThreshold(threshold.value);
        if (Number.isFinite(value) && value >= 0 && value <= 100) {
          row.threshold = String(value);
          threshold.value = row.threshold;
        }
        touch(thresholdKey);
      },
      value: row.threshold,
    });
    const typeFields =
      row.type === 'noul'
        ? noulFields(row)
        : row.type === 'choice'
          ? choiceFields(row)
          : scoreFields(row);

    return h(
      'li',
      {
        class: 'or-dec-question border rounded p-3 vstack gap-3',
        'aria-labelledby': titleId,
        'data-testid': 'dec-question',
      },
      h(
        'div',
        { class: 'd-flex align-items-center gap-2' },
        h('h4', { id: titleId, class: 'h6 mb-0 me-auto' }, `Question ${index + 1}`),
        iconButton(
          `Remove question ${index + 1}`,
          'trash',
          `${row.rid}:remove`,
          () => {
            rows = rows.filter((other) => other !== row);
            draw();
            changed();
            announce(`Question ${index + 1} removed.`);
            const next = rows[Math.min(index, rows.length - 1)];
            focusKey(element, next ? `${next.rid}:remove` : 'add-question');
          },
          false,
          'dec-question-remove',
        ),
      ),
      h(
        'div',
        { class: 'row g-2' },
        h('div', { class: 'col-12 col-sm-7' }, field(`${row.rid}:name`, 'Name', name)),
        h('div', { class: 'col-12 col-sm-5' }, field(`${row.rid}:type`, 'Type', type)),
        h(
          'div',
          { class: 'col-12 col-sm-7' },
          field(`${row.rid}:id`, 'Id', idInput, {
            help: 'Names this question in the request and the answers.',
          }),
        ),
        h(
          'div',
          { class: 'col-12 col-sm-5' },
          field(thresholdKey, 'Threshold', threshold, {
            group: [h('span', { class: 'input-group-text' }, '%')],
            help: 'Confidence needed to call an answer clear.',
          }),
        ),
      ),
      field(
        `${row.rid}:instructions`,
        'Instructions',
        textInput(row, 'instructions', {
          focus: `${row.rid}:instructions`,
          testId: 'dec-instructions',
          placeholder: 'What should the model decide?',
          multiline: true,
        }),
      ),
      typeFields,
    );
  };

  const addQuestion = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1',
      'data-focus-key': 'add-question',
      'data-testid': 'dec-add-question',
      onclick: () => {
        const row = toRow(
          blankQuestion(options.defaultThreshold?.() ?? DEFAULT_THRESHOLD),
          rows.map((r) => r.id),
        );
        rows = [...rows, row];
        draw();
        changed();
        announce(`Question ${rows.length} added.`);
        focusKey(element, `${row.rid}:name`);
      },
    },
    icon('plus-lg'),
    'Add question',
  );
  adders.set('questions', addQuestion);
  element.append(h('div', null, addQuestion));

  function draw(): void {
    entries = new Map();
    alerts = new Map();
    adders = new Map([['questions', addQuestion]]);
    replace(
      list,
      rows.map((row, index) => questionCard(row, index)),
    );
    showTouched();
  }

  return {
    element,
    questions: () => rows.map(toDef),
    keys: () => rows.map((row) => row.rid),
    thresholds: () => new Map(rows.map((row) => [row.rid, toDef(row).threshold])),
    setQuestions(questions) {
      rows = [];
      for (const def of questions)
        rows.push(
          toRow(
            def,
            rows.map((row) => row.id),
          ),
        );
      touched.clear();
      draw();
    },
    validate() {
      const problems = allProblems();
      if (problems.length === 0) {
        showTouched();
        return true;
      }
      for (const problem of problems) touched.add(keyOf(problem));
      showTouched();
      const first = problems[0]!;
      const key = keyOf(first);
      // The first problem's field takes focus and is read with its message; the others are marked and the
      // summary below says how many there are.
      const entry = entries.get(key);
      if (entry) showProblem(entry.input, entry.feedback, first.message, { focus: true });
      else adders.get(key)?.focus();
      announce(
        problems.length === 1
          ? first.message
          : `${problems.length} things to fix before this can run. ${first.message}`,
        { assertive: true },
      );
      return false;
    },
  };
}
