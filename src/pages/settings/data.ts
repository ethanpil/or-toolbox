/**
 * Settings → Data: storage used, history retention, the Record recent prompts switch, prompt and history counts
 * per tool with a delete button per row, "Delete all prompts and history" (keys, settings and stats stay) and
 * "Reset everything" (keys and settings too), both behind a typed confirmation.
 */
import { MAX_RETENTION_DAYS } from '../../core/settings/schema';
import type { CoreServices, ToolId, ToolManifest } from '../../core/types';
import { tools } from '../../tools/registry';
import { dataTable } from '../../ui/components/data-table';
import { meter } from '../../ui/components/meter';
import { switchField } from '../../ui/components/switch-field';
import { h } from '../../ui/dom';
import { confirmDialog, typedConfirm } from '../../ui/feedback/dialogs';
import { presentError } from '../../ui/feedback/errors';
import { toast } from '../../ui/feedback/toast';
import { formatInt, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { saveSettings } from '../../ui/settings-actions';
import { historyUrl, settingsUrl } from '../../ui/shell/links';
import { parseWhole, storageUsage } from './logic';
import { card, loadingLine, numberField, rerender, type SectionView } from './ui';

interface Counts {
  recent: number;
  saved: number;
  runs: number;
}

/** What a deletion says about the runs it kept: they must still book their spend when they end. */
function keptNote(keptRuns: number): string {
  if (keptRuns === 0) return '';
  return keptRuns === 1
    ? ' 1 run still in progress was kept.'
    : ` ${formatInt(keptRuns)} runs still in progress were kept.`;
}

export function dataSection(core: CoreServices): SectionView {
  let counts: Map<ToolId, Counts> | null = null;
  let countsError = false;
  let shown = false;
  const storageSlot = h(
    'div',
    { 'data-testid': 'storage-usage' },
    loadingLine('Checking storage…'),
  );
  const tableBody = h('tbody');
  const totals = h('tfoot');

  const retention = numberField<number>({
    label: 'Keep history and recent prompts for',
    help: 'Older runs and recent prompts are deleted automatically. Saved prompts and starred runs are always kept.',
    suffix: 'days',
    inputMode: 'numeric',
    testId: 'retention-days',
    className: 'or-field-narrow',
    parse: (text) => parseWhole(text, { min: 1, max: MAX_RETENTION_DAYS }),
    onCommit: (value) => {
      saveSettings(core, (draft) => {
        draft.data.retentionDays = value;
      });
    },
  });

  const recording = switchField({
    label: 'Record recent prompts',
    help: 'Each tool keeps the prompts you run in its Prompts panel. Turn this off and nothing new is recorded; saved prompts and history are not affected.',
    checked: core.settings.get().data.recordRecentPrompts,
    testId: 'record-recent',
    onChange: (checked, input) => {
      const saved = saveSettings(core, (draft) => {
        draft.data.recordRecentPrompts = checked;
      });
      if (!saved) input.checked = !checked;
    },
  });

  const loadStorage = (): void => {
    void core.data.storage().then(({ usedBytes, quotaBytes }) => {
      const usage = storageUsage(usedBytes, quotaBytes);
      rerender(
        storageSlot,
        usage === null
          ? h(
              'p',
              { class: 'text-body-secondary mb-0' },
              'This browser does not report how much storage the site uses.',
            )
          : usage.percent === null
            ? h('p', { class: 'mb-0' }, usage.text)
            : meter({
                percent: Math.max(1, Math.round(usage.percent)),
                tone: usage.percent >= 90 ? 'danger' : usage.percent >= 75 ? 'warning' : 'primary',
                label: 'Storage used',
                text: usage.text,
                testId: 'storage-meter',
              }),
      );
    });
  };

  const loadCounts = (): void => {
    Promise.all([
      core.prompts.counts(),
      Promise.all(tools.map((tool) => core.history.count({ tool: tool.id }))),
    ])
      .then(([promptCounts, runCounts]) => {
        counts = new Map(
          tools.map((tool, index) => [
            tool.id,
            {
              recent: promptCounts[tool.id]?.recent ?? 0,
              saved: promptCounts[tool.id]?.saved ?? 0,
              runs: runCounts[index] ?? 0,
            },
          ]),
        );
        countsError = false;
      })
      .catch(() => {
        countsError = true;
      })
      .finally(renderTable);
    loadStorage();
  };

  const deleteTool = async (tool: ToolManifest, count: Counts): Promise<void> => {
    const confirmed = await confirmDialog({
      title: `Delete ${tool.name} data?`,
      message: h(
        'div',
        null,
        h(
          'p',
          null,
          `This deletes ${plural(count.recent, 'recent prompt')}, ${plural(count.saved, 'saved prompt')} and ${plural(count.runs, 'run')} of history for ${tool.name}, and the work it keeps between visits, such as conversations.`,
        ),
        h(
          'p',
          { class: 'mb-0 text-body-secondary' },
          'Runs still in progress are kept. Spending stats and the other tools are not affected.',
        ),
      ),
      confirmLabel: 'Delete',
      tone: 'danger',
      testId: 'delete-tool-dialog',
    });
    if (!confirmed) return;
    try {
      const { keptRuns } = await core.data.deleteToolData(tool.id);
      toast({ message: `${tool.name}: data deleted.${keptNote(keptRuns)}`, variant: 'success' });
    } catch (error) {
      await presentError(error);
    }
  };

  const number = (value: number, testId: string): HTMLElement =>
    h(
      'td',
      { class: ['text-end', value === 0 && 'text-body-secondary'], 'data-testid': testId },
      formatInt(value),
    );

  const renderTable = (): void => {
    if (countsError) {
      rerender(
        tableBody,
        h(
          'tr',
          null,
          h('td', { colSpan: 5, class: 'text-body-secondary' }, 'The counts could not be read.'),
        ),
      );
      totals.replaceChildren();
      return;
    }
    if (counts === null) {
      rerender(tableBody, h('tr', null, h('td', { colSpan: 5 }, loadingLine('Counting…'))));
      totals.replaceChildren();
      return;
    }
    const all = { recent: 0, saved: 0, runs: 0 };
    rerender(
      tableBody,
      tools.map((tool) => {
        const count = counts!.get(tool.id) ?? { recent: 0, saved: 0, runs: 0 };
        all.recent += count.recent;
        all.saved += count.saved;
        all.runs += count.runs;
        const empty = count.recent + count.saved + count.runs === 0;
        return h(
          'tr',
          { 'data-testid': `data-row-${tool.id}` },
          h(
            'th',
            { scope: 'row', class: 'fw-normal' },
            h(
              'span',
              { class: 'd-inline-flex align-items-center gap-2 text-nowrap' },
              icon(tool.icon, 'text-primary-emphasis'),
              tool.name,
            ),
          ),
          number(count.recent, 'data-recent'),
          number(count.saved, 'data-saved'),
          h(
            'td',
            { class: 'text-end', 'data-testid': 'data-runs' },
            count.runs > 0
              ? h(
                  'a',
                  {
                    href: historyUrl({ tool: tool.id }),
                    'aria-label': `${plural(count.runs, 'run')} of ${tool.name} in History`,
                  },
                  formatInt(count.runs),
                )
              : h('span', { class: 'text-body-secondary' }, '0'),
          ),
          h(
            'td',
            { class: 'text-end' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-sm btn-outline-danger',
                'aria-label': `Delete prompts and history of ${tool.name}`,
                title: 'Delete prompts and history',
                disabled: empty,
                'data-testid': 'data-delete',
                'data-focus-key': `data:${tool.id}:delete`,
                onclick: () => void deleteTool(tool, count),
              },
              icon('trash'),
            ),
          ),
        );
      }),
      // A row's Delete is disabled once its data is gone: focus lands on this card's heading instead.
      { fallback: () => tableBody.closest('.card')?.querySelector<HTMLElement>('h3') },
    );
    totals.replaceChildren(
      h(
        'tr',
        { class: 'fw-semibold', 'data-testid': 'data-totals' },
        h('th', { scope: 'row' }, 'All tools'),
        h('td', { class: 'text-end' }, formatInt(all.recent)),
        h('td', { class: 'text-end' }, formatInt(all.saved)),
        h('td', { class: 'text-end' }, formatInt(all.runs)),
        h('td'),
      ),
    );
  };

  const deleteAll = async (): Promise<void> => {
    const confirmed = await typedConfirm({
      title: 'Delete all prompts and history?',
      message: h(
        'div',
        null,
        h(
          'p',
          null,
          'This deletes every recent and saved prompt, all history, the video job list and each tool’s saved state, for every tool.',
        ),
        h(
          'p',
          null,
          h('strong', null, 'Kept: '),
          'your keys, your settings and the spending stats your budgets use, and runs still in progress (with their tool’s saved state).',
        ),
      ),
      phrase: 'delete all',
      confirmLabel: 'Delete all',
      testId: 'delete-all-dialog',
    });
    if (!confirmed) return;
    try {
      const { keptRuns } = await core.data.deleteAllPromptsAndHistory();
      toast({
        message: `All prompts and history deleted.${keptNote(keptRuns)}`,
        variant: 'success',
      });
    } catch (error) {
      await presentError(error);
    }
  };

  const resetAll = async (): Promise<void> => {
    let toBackup = false;
    const confirmed = await typedConfirm({
      title: 'Reset everything?',
      message: h(
        'div',
        null,
        h(
          'p',
          null,
          'This deletes everything ORtoolbox stores in this browser: ',
          h('strong', null, 'your keys'),
          ', settings, prompts, history, stats and the passphrase lock. It cannot be undone.',
        ),
        h(
          'p',
          null,
          'Want a way back? ',
          // Closes the dialog first (through its own Close button), then opens Backup below. Not
          // `data-bs-dismiss` on the link: Bootstrap would take the href's #backup as the modal to hide.
          h(
            'a',
            {
              href: settingsUrl('backup'),
              onclick: (event: MouseEvent) => {
                event.preventDefault();
                toBackup = true;
                (event.currentTarget as HTMLElement)
                  .closest('.modal')
                  ?.querySelector<HTMLElement>('[data-bs-dismiss="modal"]')
                  ?.click();
              },
            },
            'Download a backup',
          ),
          ' first (with keys, if you want them back too).',
        ),
      ),
      phrase: 'reset everything',
      confirmLabel: 'Reset everything',
      testId: 'reset-dialog',
    });
    if (toBackup) location.hash = '#backup';
    if (!confirmed) return;
    try {
      await core.data.resetEverything();
      toast({
        message: 'Everything was reset. ORtoolbox is as new in this browser.',
        variant: 'success',
      });
    } catch (error) {
      await presentError(error);
    }
  };

  const dangerRow = (title: string, text: string, button: HTMLElement): HTMLElement =>
    h(
      'div',
      { class: 'd-flex flex-wrap align-items-center gap-3 py-3 border-top' },
      h(
        'div',
        { class: 'flex-grow-1 or-header-text' },
        h('div', { class: 'fw-semibold' }, title),
        h('div', { class: 'small text-body-secondary' }, text),
      ),
      button,
    );

  const element = h(
    'div',
    null,
    card(
      {
        title: 'Storage',
        icon: 'hdd',
        text: 'Everything ORtoolbox keeps lives in this browser.',
        testId: 'data-storage',
      },
      storageSlot,
    ),
    card(
      { title: 'History and prompts', icon: 'clock-history', testId: 'data-retention' },
      h('div', { class: 'vstack gap-4' }, retention.element, recording.element),
    ),
    card(
      {
        title: 'Per tool',
        icon: 'table',
        text: 'Recent and saved prompts and history runs for each tool.',
        testId: 'data-per-tool',
      },
      dataTable({
        scrollerLabel: 'Prompts and runs per tool',
        testId: 'data-table',
        head: [
          'Tool',
          'Recent',
          'Saved',
          'Runs',
          h('span', { class: 'visually-hidden' }, 'Delete'),
        ],
        numericFrom: 1,
        body: tableBody,
        foot: totals,
      }),
    ),
    card(
      { title: 'Delete data', icon: 'exclamation-octagon', testId: 'data-danger' },
      dangerRow(
        'Delete all prompts and history',
        'Every tool’s prompts, history, jobs and saved state. Your keys, settings and spending stats stay.',
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline-danger',
            'data-testid': 'delete-all',
            onclick: () => void deleteAll(),
          },
          'Delete all…',
        ),
      ),
      dangerRow(
        'Reset everything',
        'Also removes your keys, settings, stats and the passphrase lock, as if ORtoolbox had never been opened here.',
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger',
            'data-testid': 'reset-everything',
            onclick: () => void resetAll(),
          },
          'Reset everything…',
        ),
      ),
    ),
  );

  const reload = (): void => {
    if (shown) loadCounts();
  };
  core.prompts.subscribe(reload);
  core.history.subscribe(reload);
  core.settings.subscribe((next, prev) => {
    if (next.data.retentionDays !== prev.data.retentionDays)
      retention.sync(String(next.data.retentionDays));
    if (next.data.recordRecentPrompts !== prev.data.recordRecentPrompts) {
      recording.input.checked = next.data.recordRecentPrompts;
    }
  });
  retention.sync(String(core.settings.get().data.retentionDays));
  renderTable();

  return {
    element,
    onShow: () => {
      shown = true;
      loadCounts();
    },
  };
}
