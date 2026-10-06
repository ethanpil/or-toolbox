/**
 * `promptsPanel()`: the per-tool Prompts offcanvas with two tabs, Recent (filled by runs) and Saved.
 *
 * - Use restores the prompt and the tool settings saved with it (`applyState`), Save copies a Recent entry into
 *   Saved, "Save current" saves the form as it is now (`getState`), Rename, Copy and Delete per entry.
 * - Clear recent / Clear saved / Clear all for this tool.
 * - Every delete asks first and then offers Undo (`prompts.restore`) in a toast.
 * - Lists update live, also when another tab changes them; a note shows when "Record recent prompts" is off.
 */
import type { CoreServices, PromptEntry, ToolId } from '../../core/types';
import { getTool } from '../../tools/registry';
import { Offcanvas, showOffcanvas } from '../bootstrap';
import { copyWithToast } from '../clipboard';
import { h, replace } from '../dom';
import { confirmDialog, promptDialog } from '../feedback/dialogs';
import { presentError } from '../feedback/errors';
import { toast } from '../feedback/toast';
import { formatDateTime, formatRelativeTime, isoDateTime, plural } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import { settingsUrl } from '../shell/links';
import type { ToolSnapshot } from '../tool/types';
import { emptyState } from './empty-state';

export interface PromptsPanelOptions {
  tool: ToolId;
  getState: () => ToolSnapshot;
  applyState: (state: ToolSnapshot) => void;
  /**
   * The tool has no main text field (`ToolInstance.promptless`): "Save current" saves a settings-only preset
   * under a name (required, since there is no text to show), and entries offer no Copy.
   */
  promptless?: boolean;
}

export interface PromptsPanel {
  readonly element: HTMLElement;
  open(): void;
  close(): void;
}

type Kind = 'recent' | 'saved';

export function promptsPanel(core: CoreServices, options: PromptsPanelOptions): PromptsPanel {
  const { tool } = options;
  const titleId = uid('prompts-title');
  const lists: Record<Kind, PromptEntry[]> = { recent: [], saved: [] };
  let active: Kind = 'recent';
  let loaded = false;
  let generation = 0;

  const tabIds: Record<Kind, string> = { recent: uid('prompts-tab'), saved: uid('prompts-tab') };
  const paneIds: Record<Kind, string> = { recent: uid('prompts-pane'), saved: uid('prompts-pane') };
  const counts: Record<Kind, HTMLElement> = {
    recent: h(
      'span',
      { class: 'badge rounded-pill bg-secondary-subtle text-secondary-emphasis ms-1' },
      '0',
    ),
    saved: h(
      'span',
      { class: 'badge rounded-pill bg-secondary-subtle text-secondary-emphasis ms-1' },
      '0',
    ),
  };
  const panes: Record<Kind, HTMLElement> = {
    recent: h('div', {
      id: paneIds.recent,
      role: 'tabpanel',
      'aria-labelledby': tabIds.recent,
      tabIndex: 0,
      'data-testid': 'prompts-recent',
    }),
    saved: h('div', {
      id: paneIds.saved,
      role: 'tabpanel',
      'aria-labelledby': tabIds.saved,
      tabIndex: 0,
      'data-testid': 'prompts-saved',
    }),
  };

  const tab = (kind: Kind, label: string): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        id: tabIds[kind],
        class: 'nav-link',
        role: 'tab',
        'aria-controls': paneIds[kind],
        'data-testid': `prompts-tab-${kind}`,
        onclick: () => select(kind),
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            select(kind === 'recent' ? 'saved' : 'recent', true);
          }
        },
      },
      label,
      counts[kind],
    );
  const tabs: Record<Kind, HTMLButtonElement> = {
    recent: tab('recent', 'Recent'),
    saved: tab('saved', 'Saved'),
  };

  function select(kind: Kind, focus = false): void {
    active = kind;
    for (const k of ['recent', 'saved'] as const) {
      const on = k === kind;
      tabs[k].classList.toggle('active', on);
      tabs[k].setAttribute('aria-selected', String(on));
      tabs[k].tabIndex = on ? 0 : -1;
      panes[k].hidden = !on;
    }
    if (focus) tabs[kind].focus();
  }

  // --- actions ------------------------------------------------------------------------------------------

  const undoToast = (message: string, removed: PromptEntry[]): void => {
    if (removed.length === 0) {
      toast({ message: 'Nothing to delete.' });
      return;
    }
    toast({
      message,
      variant: 'success',
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => {
          core.prompts
            .restore(removed)
            .then(() =>
              toast({
                message: `Restored ${plural(removed.length, 'prompt')}.`,
                variant: 'success',
              }),
            )
            .catch((error: unknown) => void presentError(error));
        },
      },
    });
  };

  const run = (work: () => Promise<void>): void => {
    work().catch((error: unknown) => void presentError(error, { retry: () => run(work) }));
  };

  const use = (entry: PromptEntry): void => {
    options.applyState({ prompt: entry.text, settings: entry.settings });
    close();
    void core.prompts.touch(entry.id).catch(() => undefined);
    toast({
      message: entry.name ? `Loaded “${entry.name}”.` : 'Prompt loaded.',
      variant: 'success',
    });
  };

  const saveRecent = (entry: PromptEntry): void =>
    run(async () => {
      const name = await promptDialog({
        title: 'Save prompt',
        label: 'Name (optional)',
        required: false,
        help: 'The prompt and this tool’s settings are kept until you delete them.',
        icon: 'bookmark-plus',
      });
      if (name === null) return;
      await core.prompts.saveFromRecent(entry.id, name || null);
      toast({
        message: 'Prompt saved.',
        variant: 'success',
        action: { label: 'Show', onClick: () => select('saved', true) },
      });
    });

  const saveCurrent = (): void =>
    run(async () => {
      const state = options.getState();
      if (!options.promptless && !state.prompt.trim()) {
        toast({ message: 'Write a prompt first, then save it.', variant: 'warning' });
        return;
      }
      const name = await promptDialog(
        options.promptless
          ? {
              title: 'Save current settings',
              label: 'Name',
              required: true,
              help: 'Saves this tool’s current settings as a preset.',
              icon: 'bookmark-plus',
            }
          : {
              title: 'Save current prompt',
              label: 'Name (optional)',
              required: false,
              help: 'Saves the prompt together with this tool’s current settings.',
              icon: 'bookmark-plus',
            },
      );
      if (name === null) return;
      await core.prompts.save({
        tool,
        text: state.prompt,
        settings: state.settings,
        name: name || null,
      });
      select('saved');
      toast({ message: 'Prompt saved.', variant: 'success' });
    });

  const rename = (entry: PromptEntry): void =>
    run(async () => {
      const name = await promptDialog({
        title: 'Rename prompt',
        label: 'Name',
        value: entry.name ?? '',
        required: !entry.text.trim(),
        help: entry.text.trim() ? 'Leave empty to show the prompt text instead.' : undefined,
        icon: 'pencil',
      });
      if (name === null) return;
      await core.prompts.rename(entry.id, name || null);
    });

  const copy = (entry: PromptEntry): void => {
    void copyWithToast(entry.text, 'Prompt copied.');
  };

  const remove = (entry: PromptEntry): void =>
    run(async () => {
      const ok = await confirmDialog({
        title: 'Delete this prompt?',
        message:
          entry.kind === 'saved'
            ? 'The saved prompt and its settings will be deleted.'
            : 'It will be removed from Recent.',
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      tabs[active].focus();
      if (!ok) return;
      undoToast('Prompt deleted.', await core.prompts.remove([entry.id]));
    });

  const clear = (kind: Kind | 'all'): void =>
    run(async () => {
      const what =
        kind === 'all' ? 'all prompts' : kind === 'recent' ? 'recent prompts' : 'saved prompts';
      const count = kind === 'all' ? lists.recent.length + lists.saved.length : lists[kind].length;
      const ok = await confirmDialog({
        title: `Clear ${what}?`,
        message: `${plural(count, 'prompt')} for ${getTool(tool).name} will be deleted. You can undo this right after.`,
        confirmLabel: 'Clear',
        tone: 'danger',
        testId: 'clear-confirm',
      });
      tabs[active].focus();
      if (!ok) return;
      undoToast(`Cleared ${what}.`, await core.prompts.clear(tool, kind));
    });

  // --- rendering ----------------------------------------------------------------------------------------

  const actionButton = (
    entry: PromptEntry,
    label: string,
    iconName: string,
    testId: string,
    onClick: () => void,
  ): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary',
        'aria-label': label,
        title: label,
        // A rename or another tab's change re-renders the list; focus stays on the same button.
        'data-focus-key': `${entry.id}:${label}`,
        'data-testid': testId,
        onclick: onClick,
      },
      icon(iconName),
    );

  const card = (entry: PromptEntry): HTMLElement => {
    const heading = entry.name ?? null;
    const settingsCount = Object.keys(entry.settings).length;
    return h(
      'li',
      { class: 'list-group-item px-0 py-3', 'data-testid': 'prompt-entry' },
      heading &&
        h('div', { class: 'fw-semibold mb-1 text-break', 'data-testid': 'prompt-name' }, heading),
      entry.text.trim()
        ? h('div', { class: 'or-prompt-text text-break', 'data-testid': 'prompt-text' }, entry.text)
        : h(
            'div',
            { class: 'small text-body-secondary', 'data-testid': 'prompt-text' },
            'Settings only',
          ),
      h(
        'div',
        { class: 'small text-body-secondary mt-1' },
        h(
          'time',
          { dateTime: isoDateTime(entry.usedAt), title: formatDateTime(entry.usedAt) },
          formatRelativeTime(entry.usedAt),
        ),
        settingsCount > 0 ? ` · ${plural(settingsCount, 'setting')}` : '',
      ),
      h(
        'div',
        {
          class: 'd-flex flex-wrap gap-1 mt-2',
          role: 'group',
          'aria-label': `Actions for ${heading ?? 'prompt'}`,
        },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-primary',
            'data-focus-key': `${entry.id}:Use`,
            'data-testid': 'prompt-use',
            onclick: () => use(entry),
          },
          'Use',
        ),
        entry.kind === 'recent'
          ? actionButton(entry, 'Save', 'bookmark-plus', 'prompt-save', () => saveRecent(entry))
          : actionButton(entry, 'Rename', 'pencil', 'prompt-rename', () => rename(entry)),
        entry.text.trim()
          ? actionButton(entry, 'Copy', 'clipboard', 'prompt-copy', () => copy(entry))
          : null,
        actionButton(entry, 'Delete', 'trash', 'prompt-delete', () => remove(entry)),
      ),
    );
  };

  const recordingNote = (): HTMLElement | null =>
    core.settings.get().data.recordRecentPrompts
      ? null
      : h(
          'div',
          {
            class: 'alert alert-secondary small d-flex gap-2 mb-3',
            'data-testid': 'recording-off',
          },
          icon('pause-circle'),
          h(
            'div',
            null,
            'Recording recent prompts is off, so new runs are not added here. ',
            h('a', { href: settingsUrl('data') }, 'Change in Settings'),
          ),
        );

  const renderPane = (kind: Kind): void => {
    const entries = lists[kind];
    counts[kind].textContent = String(entries.length);
    tabs[kind].setAttribute(
      'aria-label',
      `${kind === 'recent' ? 'Recent' : 'Saved'}, ${plural(entries.length, 'prompt')}`,
    );
    const note = kind === 'recent' ? recordingNote() : null;
    if (!loaded) {
      replace(
        panes[kind],
        h(
          'div',
          { class: 'placeholder-glow py-3', 'aria-hidden': 'true' },
          h('span', { class: 'placeholder col-8 d-block mb-2' }),
          h('span', { class: 'placeholder col-6 d-block' }),
        ),
      );
      return;
    }
    if (entries.length === 0) {
      replace(
        panes[kind],
        note ?? '',
        emptyState(
          kind === 'recent'
            ? {
                icon: 'clock-history',
                title: 'No recent prompts',
                text: options.promptless
                  ? 'This tool has no prompt to list here; save its settings under Saved.'
                  : 'Prompts you run in this tool appear here.',
                compact: true,
                testId: 'prompts-empty',
              }
            : {
                icon: 'bookmark',
                title: 'No saved prompts',
                text: 'Save a prompt to keep it, with its settings, until you delete it.',
                compact: true,
                testId: 'prompts-empty',
              },
        ),
      );
      return;
    }
    replace(
      panes[kind],
      note ?? '',
      h('ul', { class: 'list-group list-group-flush' }, entries.map(card)),
    );
  };

  const refresh = (): void => {
    const mine = ++generation;
    Promise.all([core.prompts.list(tool, 'recent'), core.prompts.list(tool, 'saved')])
      .then(([recent, saved]) => {
        if (mine !== generation) return;
        lists.recent = recent;
        lists.saved = saved;
        loaded = true;
        renderPane('recent');
        renderPane('saved');
      })
      .catch((error: unknown) => {
        if (mine !== generation) return;
        loaded = true;
        for (const kind of ['recent', 'saved'] as const) {
          replace(
            panes[kind],
            emptyState({
              icon: 'exclamation-triangle',
              title: 'Prompts could not be loaded',
              text: error instanceof Error ? 'Browser storage is unavailable.' : '',
              compact: true,
            }),
          );
        }
      });
  };

  const clearMenu = h(
    'div',
    { class: 'dropdown' },
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-danger dropdown-toggle',
        'data-bs-toggle': 'dropdown',
        'aria-expanded': 'false',
        'data-testid': 'prompts-clear',
      },
      icon('trash', 'me-1'),
      'Clear',
    ),
    h(
      'ul',
      { class: 'dropdown-menu dropdown-menu-end shadow' },
      h(
        'li',
        null,
        h(
          'button',
          {
            type: 'button',
            class: 'dropdown-item',
            'data-testid': 'clear-recent',
            onclick: () => clear('recent'),
          },
          'Clear recent',
        ),
      ),
      h(
        'li',
        null,
        h(
          'button',
          {
            type: 'button',
            class: 'dropdown-item',
            'data-testid': 'clear-saved',
            onclick: () => clear('saved'),
          },
          'Clear saved',
        ),
      ),
      h('li', null, h('hr', { class: 'dropdown-divider' })),
      h(
        'li',
        null,
        h(
          'button',
          {
            type: 'button',
            class: 'dropdown-item text-danger-emphasis',
            'data-testid': 'clear-all',
            onclick: () => clear('all'),
          },
          'Clear all for this tool',
        ),
      ),
    ),
  );

  const element = h(
    'div',
    {
      class: 'offcanvas offcanvas-end or-prompts-panel',
      tabIndex: -1,
      'aria-labelledby': titleId,
      'data-testid': 'prompts-panel',
    },
    h(
      'div',
      { class: 'offcanvas-header border-bottom' },
      h(
        'div',
        null,
        h('h2', { class: 'offcanvas-title h5 mb-0', id: titleId }, 'Prompts'),
        h('div', { class: 'small text-body-secondary' }, getTool(tool).name),
      ),
      h('button', {
        type: 'button',
        class: 'btn-close',
        'data-bs-dismiss': 'offcanvas',
        'aria-label': 'Close',
      }),
    ),
    h(
      'div',
      { class: 'offcanvas-body pt-3' },
      h(
        'div',
        { class: 'd-flex align-items-center gap-2 mb-3' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-primary',
            'data-testid': 'prompts-save-current',
            onclick: saveCurrent,
          },
          icon('bookmark-plus', 'me-1'),
          'Save current',
        ),
        h('span', { class: 'ms-auto' }),
        clearMenu,
      ),
      h(
        'div',
        { class: 'nav nav-tabs mb-2', role: 'tablist', 'aria-label': 'Prompt lists' },
        tabs.recent,
        tabs.saved,
      ),
      panes.recent,
      panes.saved,
    ),
  );
  document.body.append(element);
  select('recent');
  renderPane('recent');
  renderPane('saved');

  core.prompts.subscribe((changed) => {
    if (changed === tool || changed === 'all') refresh();
  });
  core.settings.subscribe((next, prev) => {
    if (next.data.recordRecentPrompts !== prev.data.recordRecentPrompts) renderPane('recent');
  });
  refresh();

  const offcanvas = new Offcanvas(element);
  // Start on the selected tab, so arrow keys switch lists at once.
  element.addEventListener('shown.bs.offcanvas', () => tabs[active].focus());
  function close(): void {
    offcanvas.hide();
  }
  return {
    element,
    open: () => showOffcanvas(offcanvas, element),
    close,
  };
}
