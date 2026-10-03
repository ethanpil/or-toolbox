/**
 * Settings → Backup and restore. Export everything or settings only to `ortoolbox-YYYY-MM-DD.ortoolbox.json`;
 * keys are left out unless opted in, and then encrypted with a passphrase (`backup.export`). Import: choose or
 * drop a file, pick Merge or Replace, enter the passphrase when the file carries keys, read the preview of what
 * would change (`backup.inspect`, including skipped invalid records), then Apply (`backup.import`). The rest of
 * the page updates itself from the settings, keys and data events the import emits.
 */
import { errorCode, userMessage } from '../../core/errors';
import { downloadBlob } from '../../core/files';
import type { BackupPreview, CoreServices } from '../../core/types';
import { dropZone } from '../../ui/components/drop-zone';
import { type Child, h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { presentError } from '../../ui/feedback/errors';
import { toast } from '../../ui/feedback/toast';
import { formatBytes, formatDateTime, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { backupFilename } from './logic';
import {
  busy,
  card,
  loadingLine,
  passphraseInput,
  radioCards,
  rerender,
  type SectionView,
  switchField,
  validNewPassphrase,
} from './ui';

type Scope = 'all' | 'settings';
type Mode = 'merge' | 'replace';

export function backupSection(core: CoreServices): SectionView {
  // --- export -------------------------------------------------------------------------------------------
  let scope: Scope = 'all';
  const scopeChoice = radioCards<Scope>({
    legend: 'What to include',
    value: scope,
    columns: 'row-cols-1 row-cols-md-2',
    options: [
      {
        value: 'all',
        label: 'Everything',
        icon: 'archive',
        description:
          'Settings, saved and recent prompts, history, video jobs, tool state and spending stats.',
        testId: 'backup-scope-all',
      },
      {
        value: 'settings',
        label: 'Settings only',
        icon: 'sliders',
        description: 'Settings and saved prompts: enough to set up another browser the same way.',
        testId: 'backup-scope-settings',
      },
    ],
    onChange: (value) => {
      scope = value;
    },
  });

  const exportPassphrase = passphraseInput({
    label: 'Backup passphrase',
    autocomplete: 'new-password',
    testId: 'backup-passphrase',
    strength: true,
    help: 'You need it to restore the keys. It can differ from your lock passphrase.',
  });
  const exportConfirm = passphraseInput({
    label: 'Repeat the backup passphrase',
    autocomplete: 'new-password',
    testId: 'backup-passphrase-confirm',
  });
  const keyFields = h(
    'div',
    { class: 'vstack gap-3 or-form-narrow mt-3', hidden: true, 'data-testid': 'backup-key-fields' },
    exportPassphrase.element,
    exportConfirm.element,
  );
  const includeKeys = switchField({
    label: 'Include keys (encrypted with a passphrase)',
    help: 'Off by default: without keys you add them again after restoring. With keys, they are encrypted with AES-GCM under the passphrase you choose here.',
    checked: false,
    testId: 'backup-include-keys',
    onChange: (checked) => {
      keyFields.hidden = !checked;
      if (checked) exportPassphrase.input.focus();
    },
  });

  const exportButton = h(
    'button',
    { type: 'submit', class: 'btn btn-primary', 'data-testid': 'backup-export' },
    icon('download', 'me-2'),
    'Download backup',
  );
  const exportForm = h(
    'form',
    {
      class: 'vstack gap-4',
      noValidate: true,
      onsubmit: (event: Event) => {
        event.preventDefault();
        const withKeys = includeKeys.input.checked;
        if (withKeys && !validNewPassphrase(exportPassphrase, exportConfirm)) return;
        void busy(exportButton, async () => {
          try {
            const blob = await core.backup.export(
              withKeys
                ? { scope, includeKeys: true, passphrase: exportPassphrase.input.value }
                : { scope, includeKeys: false },
            );
            downloadBlob(blob, backupFilename());
            toast({
              message: withKeys
                ? 'Backup downloaded, with your keys encrypted. Keep the passphrase somewhere safe.'
                : 'Backup downloaded. It contains no keys.',
              variant: 'success',
            });
            exportPassphrase.input.value = '';
            exportConfirm.input.value = '';
          } catch (error) {
            await presentError(error);
          }
        });
      },
    },
    scopeChoice.element,
    h('div', null, includeKeys.element, keyFields),
    h('div', null, exportButton),
  );

  // --- import -------------------------------------------------------------------------------------------
  let file: File | null = null;
  let mode: Mode = 'merge';
  let preview: BackupPreview | null = null;
  let generation = 0;

  const fileLine = h('div', { class: 'small', hidden: true, 'data-testid': 'backup-file' });
  const previewSlot = h('div', { class: 'empty-hidden', 'data-testid': 'backup-preview' });
  const importPassphrase = passphraseInput({
    label: 'Passphrase of this backup',
    autocomplete: 'current-password',
    testId: 'backup-import-passphrase',
    help: 'This backup contains keys. Enter its passphrase to restore them, or leave it empty to restore everything else.',
  });
  const checkPassphrase = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-primary',
      'data-testid': 'backup-check-passphrase',
      onclick: () => void inspect(),
    },
    'Use passphrase',
  );
  importPassphrase.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void inspect();
    }
  });
  const passphraseBlock = h(
    'div',
    { class: 'or-form-narrow', hidden: true, 'data-testid': 'backup-passphrase-block' },
    importPassphrase.element,
    h('div', { class: 'mt-2' }, checkPassphrase),
  );

  const applyButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary',
      disabled: true,
      'data-testid': 'backup-apply',
      onclick: () => void apply(),
    },
    'Merge into this browser',
  );
  const cancelButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-secondary',
      hidden: true,
      'data-testid': 'backup-cancel',
      onclick: () => clearImport(),
    },
    'Cancel',
  );

  const modeChoice = radioCards<Mode>({
    legend: 'How to restore',
    value: mode,
    columns: 'row-cols-1 row-cols-md-2',
    options: [
      {
        value: 'merge',
        label: 'Merge',
        icon: 'union',
        description:
          'Add what is new and update what is newer; keep everything else you have here.',
        testId: 'backup-mode-merge',
      },
      {
        value: 'replace',
        label: 'Replace',
        icon: 'arrow-repeat',
        description: 'Make this browser match the backup (within what the backup contains).',
        testId: 'backup-mode-replace',
      },
    ],
    onChange: (value) => {
      mode = value;
      applyButton.className = `btn ${mode === 'replace' ? 'btn-danger' : 'btn-primary'}`;
      applyButton.textContent =
        mode === 'replace' ? 'Replace with this backup' : 'Merge into this browser';
      void inspect();
    },
  });

  const renderPreview = (result: BackupPreview): HTMLElement => {
    const counts = result.counts;
    const contents = [
      plural(counts.keys, 'key'),
      plural(counts.runs, 'run'),
      plural(counts.prompts, 'prompt'),
      plural(counts.jobs, 'job'),
      plural(counts.toolState, 'tool state entry', 'tool state entries'),
      plural(counts.statsRows, 'stats row'),
    ].filter((text) => !text.startsWith('0 '));
    return h(
      'div',
      { class: 'or-inset-panel rounded-3 p-3' },
      h(
        'div',
        { class: 'small text-body-secondary mb-2', 'data-testid': 'backup-summary' },
        `${result.scope === 'all' ? 'Everything' : 'Settings only'}, made ${result.createdAt ? formatDateTime(result.createdAt) : 'at an unknown time'} by ORtoolbox ${result.appVersion}. `,
        result.keysIncluded ? 'Keys included (encrypted). ' : 'No keys. ',
        contents.length > 0 ? `Contains ${contents.join(', ')}.` : '',
      ),
      h('h4', { class: 'h6 mb-2' }, 'What will change'),
      h(
        'ul',
        { class: 'list-unstyled mb-0 vstack gap-1', 'data-testid': 'backup-changes' },
        result.changes.map((line) => {
          const skipped = line.startsWith('Skip');
          return h(
            'li',
            { class: 'd-flex gap-2', 'data-testid': 'backup-change' },
            icon(
              skipped ? 'exclamation-triangle' : 'arrow-right-short',
              skipped ? 'text-warning-emphasis' : 'text-body-secondary',
            ),
            line,
          );
        }),
      ),
    );
  };

  const showFailure = (error: unknown): void => {
    preview = null;
    applyButton.disabled = true;
    const code = errorCode(error);
    if (code === 'wrong-passphrase') {
      passphraseBlock.hidden = false;
      importPassphrase.invalid('Wrong passphrase for this backup.');
      importPassphrase.input.focus();
      rerender(previewSlot);
    } else if (code === 'backup' || code === 'invalid-input') {
      rerender(
        previewSlot,
        h(
          'div',
          { class: 'alert alert-danger d-flex gap-2 mb-0', 'data-testid': 'backup-error' },
          icon('x-octagon-fill', 'lh-1 mt-1'),
          userMessage(error),
        ),
      );
    } else {
      rerender(previewSlot);
      void presentError(error);
    }
  };

  const options = (): { mode: Mode; passphrase?: string } =>
    importPassphrase.input.value ? { mode, passphrase: importPassphrase.input.value } : { mode };

  async function inspect(): Promise<void> {
    if (!file) return;
    const mine = ++generation;
    applyButton.disabled = true;
    importPassphrase.invalid(null);
    rerender(previewSlot, loadingLine('Reading the backup…'));
    try {
      const result = await core.backup.inspect(file, options());
      if (mine !== generation) return;
      preview = result;
      passphraseBlock.hidden = !result.keysIncluded;
      rerender(previewSlot, renderPreview(result));
      applyButton.disabled = false;
      announce(`Preview ready: ${plural(result.changes.length, 'line')} under “What will change”.`);
    } catch (error) {
      if (mine === generation) showFailure(error);
    }
  }

  const clearImport = (): void => {
    generation++;
    file = null;
    preview = null;
    importPassphrase.input.value = '';
    importPassphrase.invalid(null);
    passphraseBlock.hidden = true;
    fileLine.hidden = true;
    fileLine.replaceChildren();
    cancelButton.hidden = true;
    applyButton.disabled = true;
    rerender(previewSlot);
  };

  async function apply(): Promise<void> {
    if (!file || !preview) return;
    const chosen = file;
    await busy(applyButton, async () => {
      try {
        const result = await core.backup.import(chosen, options());
        clearImport();
        toast({
          message: `Backup restored: ${plural(result.changes.filter((line) => !line.startsWith('Skip') && line !== 'Settings unchanged').length, 'change')} applied.`,
          variant: 'success',
          testId: 'backup-restored',
        });
      } catch (error) {
        showFailure(error);
      }
    });
    applyButton.disabled = preview === null;
  }

  const chooseFile = (files: File[]): void => {
    const chosen = files[0];
    if (!chosen) return;
    file = chosen;
    importPassphrase.input.value = '';
    passphraseBlock.hidden = true;
    fileLine.hidden = false;
    cancelButton.hidden = false;
    fileLine.replaceChildren(
      icon('file-earmark-text', 'me-1'),
      h('span', { class: 'fw-semibold text-break' }, chosen.name),
      h('span', { class: 'text-body-secondary' }, ` · ${formatBytes(chosen.size)}`),
    );
    announce(`${chosen.name} chosen. Reading the backup.`);
    void inspect();
  };

  const importBody: Child[] = [
    dropZone({
      accept: ['application/json'],
      label: 'Drop a backup file here',
      hint: 'An .ortoolbox.json file from “Download backup”',
      onFiles: chooseFile,
      compact: true,
      testId: 'backup-drop',
    }),
    fileLine,
    modeChoice.element,
    passphraseBlock,
    previewSlot,
    h('div', { class: 'd-flex flex-wrap gap-2' }, applyButton, cancelButton),
  ];

  const element = h(
    'div',
    null,
    card(
      {
        title: 'Download a backup',
        icon: 'download',
        text: 'A single file to keep, or to move ORtoolbox to another browser.',
        testId: 'backup-export-card',
      },
      exportForm,
    ),
    card(
      {
        title: 'Restore from a backup',
        icon: 'upload',
        text: 'You see exactly what would change before anything is written.',
        testId: 'backup-import-card',
      },
      h('div', { class: 'vstack gap-4' }, importBody),
    ),
  );

  return { element };
}
