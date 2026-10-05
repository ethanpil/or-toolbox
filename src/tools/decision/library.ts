/**
 * The library bar above the questions: starter templates and saved deciders in one list, with Load, Save as,
 * Rename and Delete (Undo for a delete is a toast, like Prompts and Chat). A choice in the list is only a choice:
 * nothing changes in the form until Load is pressed, so arrowing through a closed list never replaces the
 * questions. Loading over questions the user has edited asks first.
 *
 * Saved deciders live in the tool's state (see saved.ts); other tabs' changes arrive on the bus and refresh the
 * list. Templates are read-only and loaded as copies.
 */
import { formatDate, plural } from '../../ui/format';
import { h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { confirmDialog, promptDialog } from '../../ui/feedback/dialogs';
import { presentError } from '../../ui/feedback/errors';
import { setFieldError } from '../../ui/feedback/field-error';
import { openModal } from '../../ui/feedback/modal';
import { toast } from '../../ui/feedback/toast';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { Bus, ToolStateStore } from '../../core/types';
import {
  findByName,
  type LoadLoss,
  loadDeciders,
  lossOnLoad,
  newDeciderId,
  removeDecider,
  type SavedDecider,
  saveDecider,
} from './saved';
import type { QuestionDef, StateDef } from './schema';
import { TEMPLATES, templateById, templateQuestions } from './templates';

export interface LibraryOptions {
  store: ToolStateStore;
  bus: Pick<Bus, 'on'>;
  tool: string;
  /** The form as it is now. */
  questions(): QuestionDef[];
  state(): StateDef;
  /** Whether the situation has anything in it worth saving. */
  hasState(): boolean;
  /** True when the questions differ from what was last loaded or saved. */
  dirty(): boolean;
  /** Puts a loaded template or decider into the form. */
  load(entry: { name: string; questions: QuestionDef[]; state: StateDef | null }): void;
  /** The questions were saved: what is in the form is now the baseline. */
  saved(): void;
}

export interface Library {
  readonly element: HTMLElement;
  reload(): Promise<void>;
}

const MAX_NAME = 80;

function lossMessage(loss: LoadLoss): string {
  if (loss.questions && loss.situation) {
    return 'The questions in the form have changed since they were loaded or saved, and this decider also brings a situation that replaces the one you typed. Use “Save as…” first to keep your questions.';
  }
  return loss.questions
    ? 'The questions in the form have changed since they were loaded or saved. Use “Save as…” first to keep them.'
    : 'This decider comes with a situation, which replaces the one in the form. Copy what you typed first if you still need it.';
}

/** Name and whether to keep the situation, or null when cancelled. */
function saveDialog(options: {
  name: string;
  canSaveState: boolean;
}): Promise<{ name: string; withState: boolean } | null> {
  let result: { name: string; withState: boolean } | null = null;
  const nameId = uid('dec-save-name');
  const stateId = uid('dec-save-state');
  const formId = uid('dec-save-form');
  const name = h('input', {
    id: nameId,
    type: 'text',
    class: 'form-control',
    maxLength: MAX_NAME,
    autocomplete: 'off',
    placeholder: 'For example: Support tickets',
    'data-testid': 'dec-save-name',
    value: options.name,
  });
  const feedback = h('div', { class: 'invalid-feedback' });
  name.addEventListener('input', () => {
    if (name.classList.contains('is-invalid')) setFieldError(name, feedback, null);
  });
  const withState = h('input', {
    id: stateId,
    type: 'checkbox',
    class: 'form-check-input',
    disabled: !options.canSaveState,
    'data-testid': 'dec-save-with-state',
  });
  const form = h(
    'form',
    {
      id: formId,
      noValidate: true,
      class: 'vstack gap-3',
      onsubmit: (event: Event) => {
        event.preventDefault();
        const value = name.value.trim();
        if (!value) {
          setFieldError(name, feedback, 'Enter a name.', { focus: true });
          return;
        }
        result = { name: value, withState: withState.checked };
        modal.hide();
      },
    },
    h('div', null, h('label', { class: 'form-label', htmlFor: nameId }, 'Name'), name, feedback),
    h(
      'div',
      { class: 'form-check' },
      withState,
      h('label', { class: 'form-check-label', htmlFor: stateId }, 'Also save the situation'),
      h(
        'div',
        { class: 'form-text mt-0' },
        options.canSaveState
          ? 'The text or fields now in the form are kept in this browser with the questions.'
          : 'There is no situation in the form to save.',
      ),
    ),
  );
  const save = h(
    'button',
    { type: 'submit', class: 'btn btn-primary', 'data-testid': 'dialog-confirm' },
    'Save',
  );
  save.setAttribute('form', formId);
  const modal = openModal({
    title: 'Save as a decider',
    icon: 'floppy',
    body: form,
    footer: [
      h(
        'button',
        { type: 'button', class: 'btn btn-outline-secondary', 'data-bs-dismiss': 'modal' },
        'Cancel',
      ),
      save,
    ],
    initialFocus: name,
    testId: 'dec-save-dialog',
  });
  modal.element.addEventListener('shown.bs.modal', () => name.select());
  return modal.closed.then(() => result);
}

export function libraryBar(options: LibraryOptions): Library {
  let saved: SavedDecider[] = [];
  const selectId = uid('dec-library');
  const describeId = uid('dec-library-describe');

  const select = h('select', {
    id: selectId,
    class: 'form-select form-select-sm',
    'aria-describedby': describeId,
    'data-testid': 'dec-library',
    onchange: () => renderState(),
  });
  const describe = h('div', {
    class: 'form-text mt-1',
    id: describeId,
    'data-testid': 'dec-library-describe',
  });

  const button = (
    label: string,
    iconName: string,
    testId: string,
    onClick: () => void,
  ): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
        'data-testid': testId,
        onclick: onClick,
      },
      icon(iconName),
      label,
    );
  const loadButton = button('Load', 'box-arrow-in-down', 'dec-load', () => void load());
  const saveButton = button('Save as…', 'floppy', 'dec-save', () => void saveAs());
  const renameButton = button('Rename', 'pencil', 'dec-rename', () => void rename());
  const deleteButton = button('Delete', 'trash', 'dec-delete', () => void remove());

  const selectedSaved = (): SavedDecider | undefined =>
    select.value.startsWith('saved:')
      ? saved.find((decider) => `saved:${decider.id}` === select.value)
      : undefined;

  /** What the choice in the list would load, in a sentence. */
  function renderState(): void {
    const decider = selectedSaved();
    const template = select.value.startsWith('template:')
      ? templateById(select.value.slice('template:'.length))
      : undefined;
    loadButton.disabled = select.value === '';
    renameButton.hidden = !decider;
    deleteButton.hidden = !decider;
    describe.textContent = template
      ? `${template.description} ${plural(template.questions.length, 'question')}.`
      : decider
        ? `Saved ${formatDate(decider.savedAt)} · ${plural(decider.questions.length, 'question')}${decider.state ? ' · includes the situation' : ''}.`
        : 'Start from a template, or load a decider you saved.';
  }

  function renderList(keep?: string): void {
    const chosen = keep ?? select.value;
    replace(
      select,
      h('option', { value: '' }, 'Choose a template or a saved decider…'),
      h(
        'optgroup',
        { label: 'Starter templates' },
        TEMPLATES.map((template) =>
          h('option', { value: `template:${template.id}` }, template.name),
        ),
      ),
      saved.length > 0
        ? h(
            'optgroup',
            { label: 'Saved deciders' },
            saved.map((decider) => h('option', { value: `saved:${decider.id}` }, decider.name)),
          )
        : null,
    );
    select.value = [...select.options].some((o) => o.value === chosen) ? chosen : '';
    renderState();
  }

  async function reload(): Promise<void> {
    try {
      saved = await loadDeciders(options.store);
    } catch (error) {
      saved = [];
      void presentError(error);
    }
    renderList();
  }

  async function load(): Promise<void> {
    const decider = selectedSaved();
    const template = select.value.startsWith('template:')
      ? templateById(select.value.slice('template:'.length))
      : undefined;
    const entry = decider
      ? { name: decider.name, questions: structuredCopy(decider.questions), state: decider.state }
      : template
        ? {
            name: template.name,
            questions: templateQuestions(template.id) ?? [],
            state: null,
          }
        : null;
    if (!entry) return;
    const loss = lossOnLoad({
      questionsEdited: options.dirty(),
      current: options.state(),
      incoming: entry.state,
    });
    if (loss.questions || loss.situation) {
      const replaceIt = await confirmDialog({
        title: loss.questions ? 'Replace your questions?' : 'Replace your situation?',
        message: lossMessage(loss),
        confirmLabel: 'Replace',
        tone: 'warning',
      });
      if (!replaceIt) return;
    }
    options.load(entry);
    announce(
      `Loaded ${entry.name}: ${plural(entry.questions.length, 'question')}${entry.state ? ' and the situation' : ''}.`,
    );
  }

  async function write(decider: SavedDecider): Promise<boolean> {
    try {
      await saveDecider(options.store, decider);
      return true;
    } catch (error) {
      void presentError(error);
      return false;
    }
  }

  async function saveAs(): Promise<void> {
    const questions = options.questions();
    if (questions.length === 0) {
      toast({ variant: 'warning', message: 'Add a question first, then save the set.' });
      return;
    }
    const answer = await saveDialog({
      name: selectedSaved()?.name ?? '',
      canSaveState: options.hasState(),
    });
    if (!answer) return;
    const existing = findByName(saved, answer.name);
    if (existing) {
      const replaceIt = await confirmDialog({
        title: `Replace “${existing.name}”?`,
        message: 'A saved decider with this name exists. Saving replaces its questions.',
        confirmLabel: 'Replace',
        tone: 'warning',
      });
      if (!replaceIt) return;
    }
    const decider: SavedDecider = {
      id: existing?.id ?? newDeciderId(),
      name: answer.name,
      questions,
      state: answer.withState ? options.state() : null,
      savedAt: Date.now(),
    };
    if (!(await write(decider))) return;
    await reload();
    select.value = `saved:${decider.id}`;
    renderState();
    options.saved();
    toast({ message: `Saved “${decider.name}”.`, variant: 'success' });
  }

  async function rename(): Promise<void> {
    const decider = selectedSaved();
    if (!decider) return;
    const name = await promptDialog({
      title: 'Rename decider',
      label: 'Name',
      value: decider.name,
      confirmLabel: 'Rename',
      maxLength: MAX_NAME,
    });
    if (!name || name === decider.name) return;
    const clash = findByName(saved, name);
    if (clash && clash.id !== decider.id) {
      toast({ variant: 'warning', message: `There is already a decider called “${clash.name}”.` });
      return;
    }
    if (!(await write({ ...decider, name }))) return;
    await reload();
    select.value = `saved:${decider.id}`;
    renderState();
    announce(`Renamed to ${name}.`);
  }

  async function remove(): Promise<void> {
    const decider = selectedSaved();
    if (!decider) return;
    try {
      await removeDecider(options.store, decider.id);
    } catch (error) {
      void presentError(error);
      return;
    }
    await reload();
    select.value = '';
    renderState();
    announce(`Deleted ${decider.name}.`);
    toast({
      message: `Deleted “${decider.name}”.`,
      action: {
        label: 'Undo',
        testId: 'dec-undo',
        // The record that was removed, under its old id: nothing else is touched.
        onClick: () =>
          void write(decider).then(async (ok) => {
            if (!ok) return;
            await reload();
            select.value = `saved:${decider.id}`;
            renderState();
            announce(`Restored ${decider.name}.`);
          }),
      },
    });
  }

  options.bus.on('tool-state-changed', (event) => {
    if (event.tool === options.tool && event.key.startsWith('decider:')) void reload();
  });

  renderList('');
  const element = h(
    'div',
    { class: 'vstack gap-2', 'data-testid': 'dec-library-bar' },
    h('label', { class: 'visually-hidden', htmlFor: selectId }, 'Templates and saved deciders'),
    select,
    describe,
    h(
      'div',
      { class: 'd-flex flex-wrap gap-2' },
      loadButton,
      saveButton,
      renameButton,
      deleteButton,
    ),
  );
  return { element, reload };
}

const structuredCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
