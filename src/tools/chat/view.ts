/**
 * Drawing one message of the conversation: author and model, branch navigation (‹ 1/3 ›), the text (plain for
 * the user, sanitised Markdown for replies), attachments, reasoning, errors and the per-message actions. Pure
 * DOM building; every decision about what an action does lives in chat.ts.
 *
 * chat.ts redraws a message only when its `messageSignature` changed, so a conversation is never rebuilt as a
 * whole. The runner's state does not rebuild anything either: `applyRunState` (fed by `runner.subscribe`) turns
 * off the buttons that start a run while it is busy or cannot run, and those that change the thread while busy.
 * Buttons are turned off with `aria-disabled` (they keep focus), and their focus keys name the place, not the
 * message (`regen:<parent>`), so focus stays put when a sibling, a regenerated reply or a retry takes its place.
 */
import type { AttachmentRef } from '../../core/attachments/attachments';
import { attachmentChip } from '../../ui/components/attachment-chip';
import { externalLink } from '../../ui/components/external-link';
import { h } from '../../ui/dom';
import { OPENROUTER_ACTIVITY_URL } from '../../ui/feedback/errors';
import { usageLine } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { composing } from '../../ui/shell/shortcuts';
import { replies } from './markdown-view';
import { siblingInfo, type ChatNode, type Thread } from './thread';

export interface MessageActions {
  copy(node: ChatNode): void;
  edit(node: ChatNode): void;
  submitEdit(node: ChatNode, text: string): void;
  cancelEdit(node: ChatNode): void;
  regenerate(node: ChatNode): void;
  retryWith(node: ChatNode): void;
  remove(node: ChatNode): void;
  sibling(node: ChatNode, delta: -1 | 1): void;
}

/** The runner's state as the message buttons see it. */
export interface RunState {
  /** A run is in progress: nothing may start one or change the thread. */
  busy: boolean;
  /** Run cannot start (no model, …): nothing may start one. */
  blocked: boolean;
}

export interface MessageContext {
  thread: Thread;
  run: RunState;
  streamingId: string | null;
  editingId: string | null;
  showReasoning: boolean;
  enterSends: boolean;
  /** The session's data URL for an attachment (undefined after a reload). */
  data: (id: string) => string | undefined;
  modelName: (id: string) => string;
  isFree: (id: string) => boolean;
  actions: MessageActions;
}

export interface MessageView {
  element: HTMLElement;
  /** Where the text goes (a reply's Markdown, the user's plain text). */
  body: HTMLElement;
  /** The reasoning text element, when shown. */
  reasoning: HTMLElement | null;
}

/** "via …" when another model than the one asked for answered (a fallback, a router, a dated snapshot). */
function servedNote(node: ChatNode, name: (id: string) => string): string | null {
  if (!node.servedModel || !node.model || node.servedModel === node.model) return null;
  return `via ${name(node.servedModel)}`;
}

/** A focus key for a message's place: its parent and role (siblings share it). */
const place = (node: ChatNode): string => `${node.parent ?? 'root'}`;

/** Sets a button off or on, keeping it focusable (`aria-disabled`); clicks on an off button do nothing. */
function setOff(button: HTMLElement, off: boolean): void {
  button.setAttribute('aria-disabled', String(off));
  button.classList.toggle('disabled', off);
}

/** What a button needs from the runner: `run` (it starts one), `idle` (it changes the thread). */
type Needs = 'run' | 'idle';

/**
 * A button that `applyRunState` turns off as its `needs` say, and that may be off for a reason of its own
 * (`off`). The handler runs only while the button is on.
 */
function guardedButton(
  attrs: Record<string, unknown>,
  onclick: () => void,
  state: { off?: boolean; needs?: Needs },
  ...children: (Node | string)[]
): HTMLButtonElement {
  const button = h(
    'button',
    {
      ...attrs,
      type: 'button',
      'data-off': state.off ? 'true' : null,
      'data-needs': state.needs ?? null,
      onclick: () => {
        if (button.getAttribute('aria-disabled') !== 'true') onclick();
      },
    },
    ...children,
  );
  setOff(button, state.off ?? false);
  return button;
}

/** Turns the buttons inside `root` that depend on the runner off or back on. */
export function applyRunState(root: ParentNode, run: RunState): void {
  for (const button of root.querySelectorAll<HTMLElement>('[data-needs]')) {
    const needs = button.dataset['needs'] as Needs;
    const off = run.busy || (needs === 'run' && run.blocked);
    setOff(button, off || button.dataset['off'] === 'true');
  }
}

const actionButton = (
  label: string,
  iconName: string,
  focusKey: string,
  onclick: () => void,
  options: { off?: boolean; needs?: Needs; testId: string },
): HTMLButtonElement =>
  guardedButton(
    {
      class: 'btn btn-sm btn-link or-icon-action',
      'aria-label': label,
      title: label,
      'data-focus-key': focusKey,
      'data-testid': options.testId,
    },
    onclick,
    options,
    icon(iconName),
  );

/** An attachment whose bytes are gone (after a reload) and that has no text to send instead. */
const isMissing = (ref: AttachmentRef, data: (id: string) => string | undefined): boolean =>
  ref.kind !== 'text' && ref.parsed === undefined && !data(ref.id);

/** Attachment chips of a sent message; binaries gone after a reload say so. */
export function attachmentList(
  refs: readonly AttachmentRef[],
  data: (id: string) => string | undefined,
): HTMLElement {
  return h(
    'ul',
    { class: 'list-unstyled d-flex flex-wrap gap-2 mb-0 mt-2', 'aria-label': 'Attachments' },
    refs.map((ref) => {
      const url = data(ref.id);
      return attachmentChip({
        ref,
        ...(url ? { data: url } : {}),
        ...(isMissing(ref, data)
          ? { missing: { note: 'Attachment not kept after reload', testId: 'attachment-missing' } }
          : {}),
        testId: 'message-attachment',
      });
    }),
  );
}

function siblingNav(node: ChatNode, ctx: MessageContext): HTMLElement | null {
  const { index, count } = siblingInfo(ctx.thread, node.id);
  if (count < 2) return null;
  const what = node.role === 'user' ? 'version of this message' : 'version of this reply';
  return h(
    'span',
    { class: 'or-chat-siblings d-inline-flex align-items-center', 'data-testid': 'sibling-nav' },
    actionButton(
      `Previous ${what}`,
      'chevron-left',
      `prev:${place(node)}`,
      () => ctx.actions.sibling(node, -1),
      { off: index === 0, needs: 'idle', testId: 'sibling-prev' },
    ),
    h(
      'span',
      { class: 'small text-body-secondary', 'data-testid': 'sibling-position' },
      h('span', { 'aria-hidden': 'true' }, `${index + 1}/${count}`),
      h('span', { class: 'visually-hidden' }, `Version ${index + 1} of ${count}`),
    ),
    actionButton(
      `Next ${what}`,
      'chevron-right',
      `next:${place(node)}`,
      () => ctx.actions.sibling(node, 1),
      { off: index === count - 1, needs: 'idle', testId: 'sibling-next' },
    ),
  );
}

function editor(node: ChatNode, ctx: MessageContext): HTMLElement {
  const id = uid('edit');
  const area = h('textarea', {
    id,
    class: 'form-control',
    rows: Math.min(12, Math.max(3, node.content.split('\n').length + 1)),
    value: node.content,
    'data-testid': 'edit-input',
    'data-focus-key': `edit:${node.id}`,
  });
  const submit = (): void => ctx.actions.submitEdit(node, area.value);
  area.addEventListener('keydown', (event) => {
    if (composing(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      ctx.actions.cancelEdit(node);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      // Ctrl/Cmd+Enter always submits; plain Enter when Enter sends. Never the page's Run shortcut.
      if (event.ctrlKey || event.metaKey || ctx.enterSends) {
        event.preventDefault();
        event.stopPropagation();
        submit();
      }
    }
  });
  return h(
    'div',
    { class: 'vstack gap-2', 'data-testid': 'message-editor' },
    h('label', { class: 'visually-hidden', htmlFor: id }, 'Edit message'),
    area,
    h(
      'div',
      { class: 'd-flex flex-wrap gap-2' },
      guardedButton(
        { class: 'btn btn-sm btn-primary', 'data-testid': 'edit-save' },
        submit,
        { needs: 'run' },
        'Save and send',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-secondary',
          'data-testid': 'edit-cancel',
          onclick: () => ctx.actions.cancelEdit(node),
        },
        'Cancel',
      ),
      h(
        'span',
        { class: 'small text-body-secondary align-self-center' },
        'Sends as a new branch; the original stays.',
      ),
    ),
  );
}

/**
 * Everything `messageView` draws from, as a string: a message is redrawn only when this changes. The text of a
 * reply still streaming is left out (the streaming view draws it), and so is whether a run is going
 * (`applyBusy`).
 */
export function messageSignature(node: ChatNode, ctx: MessageContext): string {
  const streaming = ctx.streamingId === node.id;
  const editing = ctx.editingId === node.id;
  const { index, count } = siblingInfo(ctx.thread, node.id);
  const served = node.servedModel ?? node.model ?? '';
  return JSON.stringify([
    node.role,
    streaming,
    streaming ? Boolean(node.content) : node.content,
    ctx.showReasoning ? (streaming ? Boolean(node.reasoning) : (node.reasoning ?? '')) : '',
    node.status ?? '',
    node.error ?? '',
    node.outcomeUnknown ?? false,
    node.usage ?? null,
    node.trimmed ?? 0,
    node.model ? ctx.modelName(node.model) : '',
    node.servedModel ? [node.servedModel, ctx.modelName(node.servedModel)] : '',
    node.usage ? ctx.isFree(served) : false,
    (node.attachments ?? []).map((ref) => [
      ref.id,
      ref.parsed !== undefined,
      isMissing(ref, ctx.data),
    ]),
    index,
    count,
    editing,
    editing && ctx.enterSends,
  ]);
}

/**
 * A failed reply: the message and Retry buttons. When the request may have gone through and been billed
 * (`outcomeUnknown`) there is no plain Retry, which could pay twice; a link to OpenRouter's activity takes its
 * place, and Regenerate stays for a user who has checked.
 */
function errorBlock(node: ChatNode, ctx: MessageContext, at: string): HTMLElement {
  return h(
    'div',
    {
      class: 'alert alert-danger d-flex flex-wrap align-items-center gap-2 mt-2 mb-0 py-2',
      'data-testid': 'message-error',
    },
    icon('exclamation-octagon'),
    h('span', { class: 'flex-grow-1' }, node.error ?? 'The reply failed.'),
    node.outcomeUnknown
      ? externalLink(OPENROUTER_ACTIVITY_URL, 'OpenRouter activity', 'alert-link')
      : [
          guardedButton(
            {
              class: 'btn btn-sm btn-outline-danger',
              'data-focus-key': `retry:${at}`,
              'data-testid': 'message-retry',
            },
            () => ctx.actions.regenerate(node),
            { needs: 'run' },
            'Retry',
          ),
          guardedButton(
            {
              class: 'btn btn-sm btn-outline-danger',
              'data-focus-key': `retry-with:${at}`,
              'data-testid': 'message-retry-with',
            },
            () => ctx.actions.retryWith(node),
            { needs: 'run' },
            'Retry with another model',
          ),
        ],
  );
}

export function messageView(node: ChatNode, ctx: MessageContext): MessageView {
  const user = node.role === 'user';
  const streaming = ctx.streamingId === node.id;
  const editing = ctx.editingId === node.id;
  const modelId = node.model ?? '';
  const author = user ? 'You' : modelId ? ctx.modelName(modelId) : 'Assistant';
  const served = user ? null : servedNote(node, ctx.modelName);
  const at = place(node);

  const body = h('div', {
    class: ['or-chat-body', user ? 'or-plain-text' : 'or-markdown'],
    'data-testid': 'message-content',
  });
  if (user) body.textContent = node.content;
  else if (!streaming && node.content) replies.fill(body, node.id, node.content);
  else if (!streaming && node.status === 'stopped') {
    body.append(
      h('span', { class: 'text-body-secondary fst-italic' }, 'Stopped before any text arrived.'),
    );
  }

  let reasoning: HTMLElement | null = null;
  if (!user && ctx.showReasoning && (node.reasoning || (streaming && !node.content))) {
    reasoning = h(
      'div',
      { class: 'or-plain-text small text-body-secondary' },
      node.reasoning ?? '',
    );
  }

  const actions: HTMLElement[] = [];
  if (!editing) {
    actions.push(
      actionButton('Copy message', 'clipboard', `copy:${at}`, () => ctx.actions.copy(node), {
        off: !node.content,
        testId: 'message-copy',
      }),
    );
    if (user) {
      actions.push(
        actionButton('Edit message', 'pencil', `edit-button:${at}`, () => ctx.actions.edit(node), {
          needs: 'run',
          testId: 'message-edit',
        }),
      );
    } else {
      actions.push(
        actionButton(
          'Regenerate reply',
          'arrow-repeat',
          `regen:${at}`,
          () => ctx.actions.regenerate(node),
          { needs: 'run', testId: 'message-regenerate' },
        ),
      );
    }
    actions.push(
      actionButton(
        'Delete this and what follows',
        'trash',
        `delete:${at}`,
        () => ctx.actions.remove(node),
        { needs: 'idle', testId: 'message-delete' },
      ),
    );
  }

  const element = h(
    'article',
    {
      class: ['or-chat-msg', user ? 'or-chat-msg-user' : 'or-chat-msg-reply'],
      'data-testid': 'chat-message',
      'data-role': node.role,
      'data-status': node.status ?? null,
      'aria-busy': streaming ? 'true' : null,
    },
    h(
      'div',
      { class: 'or-chat-msg-head d-flex flex-wrap align-items-center gap-2' },
      h(
        'h4',
        { class: 'or-chat-author mb-0', 'data-testid': 'message-author' },
        user ? null : icon('stars', 'me-1'),
        author,
      ),
      served &&
        h('span', { class: 'small text-body-secondary', 'data-testid': 'message-served' }, served),
      siblingNav(node, ctx),
    ),
    reasoning &&
      h(
        'details',
        { class: 'or-chat-reasoning', 'data-testid': 'message-reasoning' },
        h('summary', { class: 'small' }, streaming && !node.content ? 'Thinking…' : 'Reasoning'),
        reasoning,
      ),
    editing ? editor(node, ctx) : body,
    !editing && node.attachments?.length ? attachmentList(node.attachments, ctx.data) : null,
    node.trimmed
      ? h(
          'p',
          { class: 'small text-body-secondary mb-0 mt-2', 'data-testid': 'message-trimmed' },
          icon('scissors', 'me-1'),
          `The ${node.trimmed === 1 ? 'earliest message was' : `${node.trimmed} earliest messages were`} left out to fit the model's context window.`,
        )
      : null,
    node.status === 'error' ? errorBlock(node, ctx, at) : null,
    editing
      ? null
      : h(
          'div',
          { class: 'or-chat-msg-foot d-flex flex-wrap align-items-center gap-1' },
          !user && node.usage
            ? h(
                'span',
                { class: 'small text-body-secondary me-auto', 'data-testid': 'message-usage' },
                usageLine(node.usage, { free: ctx.isFree(node.servedModel ?? modelId) }),
              )
            : h('span', { class: 'me-auto' }),
          !user && node.status === 'stopped'
            ? h(
                'span',
                { class: 'badge text-bg-secondary', 'data-testid': 'message-stopped' },
                'Stopped',
              )
            : null,
          actions,
        ),
  );
  applyRunState(element, ctx.run);
  return { element, body, reasoning };
}
