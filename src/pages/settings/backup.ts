/**
 * Settings → Backup and restore. Export everything or settings only to `ortoolbox-YYYY-MM-DD.ortoolbox.json`;
 * keys are left out unless opted in, and then encrypted with a passphrase (`backup.export`). Import: choose or
 * drop a file, pick Merge or Replace, enter the passphrase when the file carries keys, read the preview of what
 * would change (`backup.inspect`, including skipped invalid records), then Apply (`backup.import`). The rest of
 * the page updates itself from the settings, keys and data events the import emits.
 *
 * Apply imports exactly what the preview showed: the file and options are captured when the preview is made,
 * and any change to them (mode, passphrase, file) discards the preview until Preview runs again. Replace lists
 * what it deletes, set apart in the preview and again in a confirmation, before anything is written.
 */
import { errorCode, userMessage } from '../../core/errors';
import { downloadBlob } from '../../core/files';
import type { BackupPreview, CoreServices } from '../../core/types';
import { dropZone } from '../../ui/components/drop-zone';
import { type Child, h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { confirmDialog } from '../../ui/feedback/dialogs';
import { presentError } from '../../ui/feedback/errors';
import { toast } from '../../ui/feedback/toast';
import { formatBytes, formatDateTime, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { backupFilename, isDestructiveChange } from './logic';
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
type ImportOptions = { mode: Mode; passphrase?: string };

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
            exportPassphrase.clear();
            exportConfirm.clear();
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
  /** The shown preview and exactly what it was made from; null when there is none or it went stale. */
  let previewed: { file: File; options: ImportOptions; preview: BackupPreview } | null = null;
  let generation = 0;

  const fileLine = h('div', { class: 'small', hidden: true, 'data-testid': 'backup-file' });
  const previewSlot = h('div', { class: 'empty-hidden', 'data-testid': 'backup-preview' });
  const staleNote = h(
    'div',
    {
      class: 'alert alert-secondary d-flex gap-2 align-items-center small mb-0',
      hidden: true,
      'data-testid': 'backup-stale',
    },
    icon('arrow-repeat'),
    'You changed what to restore. Press Preview to see what would change.',
  );
  const importPassphrase = passphraseInput({
    label: 'Passphrase of this backup',
    autocomplete: 'current-password',
    testId: 'backup-import-passphrase',
    help: 'This backup contains keys. Enter its passphrase and press Preview to restore them, or leave it empty to restore everything else.',
  });
  importPassphrase.input.addEventListener('input', () => invalidate());
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
  );

  const previewButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-primary',
      hidden: true,
      'data-testid': 'backup-preview-button',
      onclick: () => void inspect(),
    },
    icon('eye', 'me-2'),
    'Preview',
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
        description:
          'Make this browser match the backup: what the backup lacks is deleted (within what it contains).',
        testId: 'backup-mode-replace',
      },
    ],
    onChange: (value) => {
      mode = value;
      applyButton.className = `btn ${mode === 'replace' ? 'btn-danger' : 'btn-primary'}`;
      applyButton.textContent =
        mode === 'replace' ? 'Replace with this backup' : 'Merge into this browser';
      invalidate();
    },
  });

  const changeItem = (line: string): HTMLElement => {
    const skipped = line.startsWith('Skip');
    const destructive = isDestructiveChange(line);
    return h(
      'li',
      { class: 'd-flex gap-2', 'data-testid': 'backup-change' },
      icon(
        destructive ? 'trash3' : skipped ? 'exclamation-triangle' : 'arrow-right-short',
        destructive
          ? 'text-danger-emphasis'
          : skipped
            ? 'text-warning-emphasis'
            : 'text-body-secondary',
      ),
      line,
    );
  };

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
    const destructive = result.changes.filter(isDestructiveChange);
    const other = result.changes.filter((line) => !isDestructiveChange(line));
    return h(
      'div',
      { class: 'or-inset-panel rounded-3 p-3 vstack gap-3' },
      h(
        'div',
        { class: 'small text-body-secondary', 'data-testid': 'backup-summary' },
        `${result.scope === 'all' ? 'Everything' : 'Settings only'}, made ${result.createdAt ? formatDateTime(result.createdAt) : 'at an unknown time'} by ORtoolbox ${result.appVersion}. `,
        result.keysIncluded ? 'Keys included (encrypted). ' : 'No keys. ',
        contents.length > 0 ? `Contains ${contents.join(', ')}.` : '',
      ),
      destructive.length > 0 &&
        h(
          'div',
          {
            class: 'border border-danger-subtle rounded-3 p-3',
            'data-testid': 'backup-destructive',
          },
          h('h4', { class: 'h6 text-danger-emphasis mb-2' }, 'Deleted or replaced in this browser'),
          h('ul', { class: 'list-unstyled mb-0 vstack gap-1' }, destructive.map(changeItem)),
        ),
      other.length > 0 &&
        h(
          'div',
          null,
          h('h4', { class: 'h6 mb-2' }, destructive.length > 0 ? 'Also' : 'What will change'),
          h(
            'ul',
            { class: 'list-unstyled mb-0 vstack gap-1', 'data-testid': 'backup-changes' },
            other.map(changeItem),
          ),
        ),
    );
  };

  const showFailure = (error: unknown): void => {
    previewed = null;
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

  /** The preview no longer matches the form: drop it, and Apply waits for a new Preview. */
  function invalidate(): void {
    if (!file) return;
    generation++;
    const hadPreview = previewed !== null || previewSlot.childElementCount > 0;
    previewed = null;
    applyButton.disabled = true;
    rerender(previewSlot);
    if (hadPreview) staleNote.hidden = false;
  }

  async function inspect(): Promise<void> {
    if (!file) return;
    const mine = ++generation;
    const source = file;
    const options: ImportOptions = importPassphrase.input.value
      ? { mode, passphrase: importPassphrase.input.value }
      : { mode };
    previewed = null;
    applyButton.disabled = true;
    staleNote.hidden = true;
    importPassphrase.invalid(null);
    rerender(previewSlot, loadingLine('Reading the backup…'));
    try {
      const preview = await core.backup.inspect(source, options);
      if (mine !== generation) return;
      previewed = { file: source, options, preview };
      passphraseBlock.hidden = !preview.keysIncluded;
      rerender(previewSlot, renderPreview(preview));
      applyButton.disabled = false;
      announce(
        `Preview ready: ${plural(preview.changes.length, 'line')} under “What will change”.`,
      );
    } catch (error) {
      if (mine === generation) showFailure(error);
    }
  }

  function clearImport(): void {
    generation++;
    file = null;
    previewed = null;
    importPassphrase.clear();
    passphraseBlock.hidden = true;
    fileLine.hidden = true;
    fileLine.replaceChildren();
    previewButton.hidden = true;
    cancelButton.hidden = true;
    staleNote.hidden = true;
    applyButton.disabled = true;
    rerender(previewSlot);
  }

  /** Replace deletes what the backup lacks: say what, and ask. */
  const confirmReplace = (preview: BackupPreview, options: ImportOptions): Promise<boolean> =>
    confirmDialog({
      title: 'Replace with this backup?',
      message: h(
        'div',
        null,
        h('p', null, 'This browser is made to match the backup. That means:'),
        h(
          'ul',
          null,
          preview.changes.filter(isDestructiveChange).map((line) => h('li', null, line)),
          preview.scope === 'all' &&
            h(
              'li',
              null,
              'Replace deletes runs and jobs that are not in the backup, even newer ones, and replaces the spending stats your budgets count.',
            ),
          preview.keysIncluded && options.passphrase !== undefined
            ? h('li', null, 'Your keys are replaced by the backup’s.')
            : null,
        ),
        h(
          'p',
          { class: 'mb-0' },
          'This cannot be undone. Download a backup of this browser first if you may want it back.',
        ),
      ),
      confirmLabel: 'Replace',
      tone: 'danger',
      testId: 'replace-confirm-dialog',
    });

  async function apply(): Promise<void> {
    const chosen = previewed;
    if (!chosen) return;
    if (
      chosen.options.mode === 'replace' &&
      !(await confirmReplace(chosen.preview, chosen.options))
    )
      return;
    if (previewed !== chosen) return; // changed while the confirmation was open
    await busy(applyButton, async () => {
      try {
        // Exactly what the preview was made from, never the current state of the form.
        const result = await core.backup.import(chosen.file, chosen.options);
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
    applyButton.disabled = previewed === null;
  }

  const chooseFile = (files: File[]): void => {
    const chosen = files[0];
    if (!chosen) return;
    file = chosen;
    importPassphrase.clear();
    passphraseBlock.hidden = true;
    fileLine.hidden = false;
    previewButton.hidden = false;
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
    staleNote,
    previewSlot,
    h('div', { class: 'd-flex flex-wrap gap-2' }, previewButton, applyButton, cancelButton),
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
