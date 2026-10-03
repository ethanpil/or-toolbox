/**
 * Drawing one message of the conversation: author and model, branch navigation (‹ 1/3 ›), the text (plain for
 * the user, sanitised Markdown for replies), attachments, reasoning, errors and the per-message actions. Pure
 * DOM building; every decision about what an action does lives in chat.ts.
 */
import { h } from '../../ui/dom';
import { formatBytes, formatCount, formatMs, formatUsd } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { fillReply } from './markdown-view';
import {
  siblingInfo,
  type AttachmentKind,
  type AttachmentRef,
  type ChatNode,
  type Thread,
} from './thread';

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

export interface MessageContext {
  thread: Thread;
  /** A run is in progress: actions that start one, or change the tree, are disabled. */
  busy: boolean;
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

export const KIND_ICONS: Readonly<Record<AttachmentKind, string>> = {
  image: 'file-earmark-image',
  pdf: 'file-earmark-pdf',
  audio: 'file-earmark-music',
  text: 'file-earmark-text',
};

/** Token, cost and latency line of a reply. */
export function usageLine(node: ChatNode, free: boolean): string {
  const usage = node.usage;
  if (!usage) return '';
  const cost = usage.costUnknown
    ? 'cost unknown'
    : free && usage.costUsd === 0
      ? 'free'
      : `${usage.costEstimated ? '≈ ' : ''}${formatUsd(usage.costUsd)}`;
  return [
    `${formatCount(usage.promptTokens)} in · ${formatCount(usage.completionTokens)} out`,
    cost,
    usage.latencyMs > 0 ? formatMs(usage.latencyMs) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "via …" when the reply came from another model than asked (a fallback); dated snapshots don't count. */
function servedNote(node: ChatNode, name: (id: string) => string): string | null {
  if (!node.servedModel || !node.model || node.servedModel.startsWith(node.model)) return null;
  return `via ${name(node.servedModel)}`;
}

const actionButton = (
  label: string,
  iconName: string,
  focusKey: string,
  onclick: () => void,
  options: { disabled?: boolean; testId: string },
): HTMLButtonElement =>
  h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-link or-chat-action',
      'aria-label': label,
      title: label,
      disabled: options.disabled ?? false,
      'data-focus-key': focusKey,
      'data-testid': options.testId,
      onclick,
    },
    icon(iconName),
  );

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
      const missing = ref.kind !== 'text' && !url;
      return h(
        'li',
        {
          class: ['or-chat-attachment', missing && 'is-missing'],
          'data-testid': 'message-attachment',
        },
        ref.kind === 'image' && url
          ? h('img', { class: 'or-chat-thumb', src: url, alt: '' })
          : icon(KIND_ICONS[ref.kind]),
        h(
          'span',
          { class: 'min-w-0' },
          h('span', { class: 'd-block text-truncate' }, ref.name),
          h(
            'span',
            {
              class: ['d-block small', missing ? 'text-warning-emphasis' : 'text-body-secondary'],
              'data-testid': missing ? 'attachment-missing' : null,
            },
            missing ? 'Attachment not kept after reload' : formatBytes(ref.size),
          ),
        ),
      );
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
      `prev:${node.id}`,
      () => ctx.actions.sibling(node, -1),
      {
        disabled: ctx.busy || index === 0,
        testId: 'sibling-prev',
      },
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
      `next:${node.id}`,
      () => ctx.actions.sibling(node, 1),
      {
        disabled: ctx.busy || index === count - 1,
        testId: 'sibling-next',
      },
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
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      ctx.actions.cancelEdit(node);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing) {
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
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-primary',
          disabled: ctx.busy,
          'data-testid': 'edit-save',
          onclick: submit,
        },
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

export function messageView(node: ChatNode, ctx: MessageContext): MessageView {
  const user = node.role === 'user';
  const streaming = ctx.streamingId === node.id;
  const editing = ctx.editingId === node.id;
  const modelId = node.model ?? '';
  const author = user ? 'You' : modelId ? ctx.modelName(modelId) : 'Assistant';
  const served = user ? null : servedNote(node, ctx.modelName);

  const body = h('div', {
    class: ['or-chat-body', user ? 'or-plain-text' : 'or-markdown'],
    'data-testid': 'message-content',
  });
  if (user) body.textContent = node.content;
  else if (!streaming && node.content) fillReply(body, node.id, node.content);
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
      actionButton('Copy message', 'clipboard', `copy:${node.id}`, () => ctx.actions.copy(node), {
        disabled: !node.content,
        testId: 'message-copy',
      }),
    );
    if (user) {
      actions.push(
        actionButton(
          'Edit message',
          'pencil',
          `edit-button:${node.id}`,
          () => ctx.actions.edit(node),
          {
            disabled: ctx.busy,
            testId: 'message-edit',
          },
        ),
      );
    } else {
      actions.push(
        actionButton(
          'Regenerate reply',
          'arrow-repeat',
          `regen:${node.id}`,
          () => ctx.actions.regenerate(node),
          {
            disabled: ctx.busy,
            testId: 'message-regenerate',
          },
        ),
      );
    }
    actions.push(
      actionButton(
        'Delete this and what follows',
        'trash',
        `delete:${node.id}`,
        () => ctx.actions.remove(node),
        {
          disabled: ctx.busy,
          testId: 'message-delete',
        },
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
    node.status === 'error'
      ? h(
          'div',
          {
            class: 'alert alert-danger d-flex flex-wrap align-items-center gap-2 mt-2 mb-0 py-2',
            'data-testid': 'message-error',
          },
          icon('exclamation-octagon'),
          h('span', { class: 'flex-grow-1' }, node.error ?? 'The reply failed.'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-danger',
              disabled: ctx.busy,
              'data-focus-key': `retry:${node.id}`,
              'data-testid': 'message-retry',
              onclick: () => ctx.actions.regenerate(node),
            },
            'Retry',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-danger',
              disabled: ctx.busy,
              'data-focus-key': `retry-with:${node.id}`,
              'data-testid': 'message-retry-with',
              onclick: () => ctx.actions.retryWith(node),
            },
            'Retry with another model',
          ),
        )
      : null,
    editing
      ? null
      : h(
          'div',
          { class: 'or-chat-msg-foot d-flex flex-wrap align-items-center gap-1' },
          !user && node.usage
            ? h(
                'span',
                { class: 'small text-body-secondary me-auto', 'data-testid': 'message-usage' },
                usageLine(node, ctx.isFree(node.servedModel ?? modelId)),
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
  return { element, body, reasoning };
}
