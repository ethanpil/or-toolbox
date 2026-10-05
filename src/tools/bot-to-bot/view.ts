/**
 * Drawing the transcript: bot turns as bubbles with an avatar (Bot A on the left, Bot B on the right), the opening
 * prompt and moderator messages as centred moderator bubbles, end markers as a divider, and the inline editor.
 * Pure DOM building; what the buttons do lives in tool.ts.
 *
 * tool.ts redraws an entry only when its `entrySignature` changed. A run in progress never rebuilds anything:
 * `applyBusy` turns the buttons that change the transcript (Edit) off with `aria-disabled`, so they keep focus,
 * and focus keys name the entry (`edit-button:<id>`), so focus survives a redraw.
 */
import { externalLink } from '../../ui/components/external-link';
import type { MarkdownCache } from '../../ui/components/markdown-cache';
import { h } from '../../ui/dom';
import { OPENROUTER_ACTIVITY_URL } from '../../ui/feedback/errors';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { plural } from '../../ui/format';
import { composing } from '../../ui/shell/shortcuts';
import type { Entry, Speaker } from './conversation';
import { END_TITLES, initials, turnUsageLine } from './format';

export interface EntryActions {
  copy(entry: Entry): void;
  edit(entry: Entry): void;
  save(entry: Entry, text: string): void;
  cancel(entry: Entry): void;
}

export interface EntryContext {
  streamingId: string | null;
  editingId: string | null;
  busy: boolean;
  /** Entries after this one (Save removes them). */
  after: (id: string) => number;
  modelName: (id: string) => string;
  isFree: (id: string) => boolean;
  /** The tool's one cache of rendered turns (a finished turn is pre-rendered before its redraw). */
  markdown: MarkdownCache;
  actions: EntryActions;
}

export interface EntryView {
  element: HTMLElement;
  /** Where a bot turn's text streams. */
  body: HTMLElement | null;
}

/** An avatar: the name's initials in the bot's colour. Decorative (the name is always shown next to it). */
export function avatar(speaker: Speaker, name: string, size: 'sm' | 'md' = 'md'): HTMLElement {
  return h(
    'span',
    {
      class: ['or-bot-avatar', `or-bot-avatar-${speaker}`, size === 'sm' && 'or-bot-avatar-sm'],
      'aria-hidden': 'true',
      'data-testid': `avatar-${speaker}`,
    },
    initials(name),
  );
}

// --- buttons that follow the run ---------------------------------------------------------------------------

function setOff(button: HTMLElement, off: boolean): void {
  button.setAttribute('aria-disabled', String(off));
  button.classList.toggle('disabled', off);
}

/** A button that `applyBusy` turns off while a run is going (it keeps focus); clicks on it do nothing then. */
function idleButton(
  attrs: Record<string, unknown>,
  onclick: () => void,
  busy: boolean,
  ...children: (Node | string)[]
): HTMLButtonElement {
  const button = h(
    'button',
    {
      ...attrs,
      type: 'button',
      'data-needs-idle': 'true',
      onclick: () => {
        if (button.getAttribute('aria-disabled') !== 'true') onclick();
      },
    },
    ...children,
  );
  setOff(button, busy);
  return button;
}

/** Turns the transcript's Edit buttons off while a run is going, and back on. */
export function applyBusy(root: ParentNode, busy: boolean): void {
  for (const button of root.querySelectorAll<HTMLElement>('[data-needs-idle]'))
    setOff(button, busy);
}

const iconButton = (
  label: string,
  name: string,
  focusKey: string,
  testId: string,
  onclick: () => void,
): HTMLButtonElement =>
  h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-link or-icon-action',
      'aria-label': label,
      title: label,
      'data-focus-key': focusKey,
      'data-testid': testId,
      onclick,
    },
    icon(name),
  );

function editor(entry: Entry, ctx: EntryContext): HTMLElement {
  const id = uid('edit');
  const noteId = uid('edit-note');
  const after = ctx.after(entry.id);
  const area = h('textarea', {
    id,
    class: 'form-control',
    rows: Math.min(12, Math.max(3, entry.content.split('\n').length + 1)),
    value: entry.content,
    'aria-describedby': noteId,
    'data-testid': 'edit-input',
    'data-focus-key': `edit:${entry.id}`,
  });
  const save = (): void => ctx.actions.save(entry, area.value);
  area.addEventListener('keydown', (event) => {
    if (composing(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      ctx.actions.cancel(entry);
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      // Never the page's Run shortcut.
      event.preventDefault();
      event.stopPropagation();
      save();
    }
  });
  return h(
    'div',
    { class: 'vstack gap-2', 'data-testid': 'entry-editor' },
    h('label', { class: 'visually-hidden', htmlFor: id }, 'Edit this message'),
    area,
    h(
      'div',
      { class: 'd-flex flex-wrap align-items-center gap-2' },
      idleButton(
        {
          class: 'btn btn-sm btn-primary',
          'data-focus-key': `save:${entry.id}`,
          'data-testid': 'edit-save',
        },
        save,
        ctx.busy,
        'Save',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-secondary',
          'data-testid': 'edit-cancel',
          onclick: () => ctx.actions.cancel(entry),
        },
        'Cancel',
      ),
      h(
        'span',
        { id: noteId, class: 'small text-body-secondary' },
        after > 0
          ? `Saving removes the ${plural(after, 'message')} after it; Undo brings ${after === 1 ? 'it' : 'them'} back. Resume carries on from here.`
          : 'Resume carries on from here.',
      ),
    ),
  );
}

/** Everything `entryView` draws from: an entry is redrawn only when this changes. */
export function entrySignature(entry: Entry, ctx: EntryContext): string {
  const streaming = ctx.streamingId === entry.id;
  const editing = ctx.editingId === entry.id;
  return JSON.stringify([
    entry.kind,
    streaming,
    streaming ? Boolean(entry.content) : entry.content,
    entry.status ?? '',
    entry.error ?? '',
    entry.outcomeUnknown === true,
    entry.usage ?? null,
    entry.trimmed ?? 0,
    entry.edited === true,
    entry.name ?? '',
    entry.model ? [entry.model, ctx.modelName(entry.model), ctx.isFree(entry.model)] : '',
    entry.reason ?? '',
    editing,
    editing ? ctx.after(entry.id) : 0,
  ]);
}

/**
 * What a failed turn says: the stored `failureText` wording. One that may have gone through (`outcomeUnknown`)
 * already says to check before sending again, so it links the OpenRouter activity instead of inviting a Resume.
 */
function failureNote(entry: Entry): HTMLElement {
  const text = entry.error ?? 'The turn failed.';
  return h(
    'span',
    null,
    entry.outcomeUnknown
      ? [text, ' ', externalLink(OPENROUTER_ACTIVITY_URL, 'OpenRouter activity', 'alert-link')]
      : `${text} Resume to try again.`,
  );
}

const STATUS_BADGES: Partial<
  Record<NonNullable<Entry['status']>, { text: string; title: string }>
> = {
  cut: { text: 'Cut', title: 'The time limit ended this turn mid-sentence.' },
  stopped: { text: 'Stopped', title: 'Stopped before the turn was finished.' },
};

function footer(entry: Entry, ctx: EntryContext, editable: boolean): HTMLElement {
  const badge = entry.status ? STATUS_BADGES[entry.status] : undefined;
  return h(
    'div',
    { class: 'or-bot-foot d-flex flex-wrap align-items-center gap-1' },
    entry.kind === 'bot' && entry.usage
      ? h(
          'span',
          { class: 'small text-body-secondary me-auto', 'data-testid': 'turn-usage' },
          turnUsageLine(entry.usage, ctx.isFree(entry.model ?? '')),
        )
      : h('span', { class: 'me-auto' }),
    badge
      ? h(
          'span',
          {
            class: 'badge text-bg-secondary',
            title: badge.title,
            'data-testid': `turn-${entry.status}`,
          },
          badge.text,
        )
      : null,
    entry.edited
      ? h('span', { class: 'badge text-bg-secondary', 'data-testid': 'turn-edited' }, 'Edited')
      : null,
    entry.content
      ? iconButton('Copy this message', 'clipboard', `copy:${entry.id}`, 'turn-copy', () =>
          ctx.actions.copy(entry),
        )
      : null,
    editable
      ? idleButton(
          {
            class: 'btn btn-sm btn-link or-icon-action',
            'aria-label': 'Edit this message',
            title: 'Edit this message',
            'data-focus-key': `edit-button:${entry.id}`,
            'data-testid': 'turn-edit',
          },
          () => ctx.actions.edit(entry),
          ctx.busy,
          icon('pencil'),
        )
      : null,
  );
}

function botView(entry: Entry, ctx: EntryContext): EntryView {
  const speaker = entry.speaker ?? 'a';
  const streaming = ctx.streamingId === entry.id;
  const editing = ctx.editingId === entry.id;
  const failed = entry.status === 'error';
  const body = h('div', { class: 'or-bot-body or-markdown', 'data-testid': 'turn-content' });
  if (!streaming && entry.content) ctx.markdown.fill(body, entry.id, entry.content);
  const name = entry.name ?? (speaker === 'a' ? 'Bot A' : 'Bot B');
  const element = h(
    'article',
    {
      class: ['or-bot-turn', `or-bot-turn-${speaker}`],
      'data-testid': 'bot-turn',
      'data-speaker': speaker,
      'data-status': entry.status ?? null,
      'aria-busy': streaming ? 'true' : null,
    },
    avatar(speaker, name),
    h(
      'div',
      { class: 'or-bot-bubble' },
      h(
        'div',
        { class: 'or-bot-head d-flex flex-wrap align-items-baseline gap-2' },
        h('h4', { class: 'or-bot-name mb-0', 'data-testid': 'turn-name' }, name),
        entry.model
          ? h(
              'span',
              { class: 'small text-body-secondary text-truncate', 'data-testid': 'turn-model' },
              ctx.modelName(entry.model),
            )
          : null,
      ),
      editing ? editor(entry, ctx) : body,
      streaming && !entry.content
        ? h(
            'p',
            { class: 'small text-body-secondary mb-0', 'data-testid': 'turn-waiting' },
            h('span', { class: 'spinner-grow spinner-grow-sm me-2', 'aria-hidden': 'true' }),
            'Thinking…',
          )
        : null,
      entry.trimmed
        ? h(
            'p',
            { class: 'small text-body-secondary mb-0 mt-2', 'data-testid': 'turn-trimmed' },
            icon('scissors', 'me-1'),
            `Left out the ${entry.trimmed === 1 ? 'oldest message' : `${entry.trimmed} oldest messages`} to fit the model's context window.`,
          )
        : null,
      failed
        ? h(
            'div',
            {
              class: 'alert alert-danger d-flex gap-2 align-items-start mt-2 mb-0 py-2 small',
              'data-testid': 'turn-error',
            },
            icon('exclamation-octagon'),
            failureNote(entry),
          )
        : null,
      editing || streaming ? null : footer(entry, ctx, !failed),
    ),
  );
  return { element, body };
}

function moderatorView(entry: Entry, ctx: EntryContext): EntryView {
  const editing = ctx.editingId === entry.id;
  const opener = entry.kind === 'opener';
  const body = h(
    'div',
    { class: 'or-bot-mod-body or-plain-text', 'data-testid': 'turn-content' },
    entry.content,
  );
  const element = h(
    'article',
    {
      class: 'or-bot-mod',
      'data-testid': 'moderator-message',
      'data-kind': entry.kind,
    },
    h(
      'div',
      { class: 'or-bot-mod-bubble' },
      h(
        'h4',
        { class: 'or-bot-mod-title mb-1' },
        icon(opener ? 'flag' : 'megaphone', 'me-1'),
        opener ? 'Opening prompt' : 'Moderator',
      ),
      editing ? editor(entry, ctx) : body,
      editing ? null : footer(entry, ctx, true),
    ),
  );
  return { element, body: null };
}

function endView(entry: Entry): EntryView {
  const reason = entry.reason ?? 'stopped';
  return {
    element: h(
      'div',
      { class: 'or-bot-end', 'data-testid': 'conversation-end', 'data-reason': reason },
      h(
        'p',
        { class: 'mb-0' },
        icon(reason === 'stopped' ? 'stop-circle' : 'flag-fill', 'me-1'),
        h('strong', null, `Ended · ${END_TITLES[reason]}`),
        h('span', { class: 'd-block small text-body-secondary' }, entry.content),
      ),
    ),
    body: null,
  };
}

export function entryView(entry: Entry, ctx: EntryContext): EntryView {
  if (entry.kind === 'bot') return botView(entry, ctx);
  if (entry.kind === 'end') return endView(entry);
  return moderatorView(entry, ctx);
}
