/**
 * Transcripts of a conversation: Markdown (Copy, the Markdown download and the run's output, which History shows
 * as the conversation's replay) and JSON, both with per-turn stats and the totals against the limits.
 *
 * The Markdown's structure is its level-2 headings (each entry, the end, the totals). Text from the bots and the
 * moderator goes through `safeBlock`, so it can neither run on past its section (a code fence left open is
 * closed, an HTML comment cannot swallow the rest) nor pass for structure (headings, rules and setext
 * underlines are escaped outside code).
 */
import { formatMs, formatUsd, plural } from '../../ui/format';
import { safeBlock } from '../../ui/markdown-safe';
import { type Conversation, type Entry, turnCount } from './conversation';
import { END_TITLES, turnUsageLine } from './format';
import type { Limits } from './loop';

export interface ExportContext {
  limits: Limits;
  isFree: (model: string) => boolean;
}

/** A name or a model id for a heading: one line. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const quote = (text: string): string =>
  safeBlock(text.trim())
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');

const STATUS_NOTES: Partial<Record<NonNullable<Entry['status']>, string>> = {
  cut: '_(cut off by the time limit)_',
  stopped: '_(stopped)_',
};

export function toMarkdown(conversation: Conversation, context: ExportContext): string {
  const { a, b } = conversation.bots;
  const parts: string[] = [`# ${oneLine(a.name)} and ${oneLine(b.name)}`];
  for (const bot of [a, b]) {
    parts.push(
      [
        `**${oneLine(bot.name)}** · ${oneLine(bot.model) || 'default model'}`,
        bot.persona.trim() && quote(bot.persona),
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }
  let turn = 0;
  for (const entry of conversation.entries) {
    switch (entry.kind) {
      case 'opener':
        parts.push('## Opening prompt', safeBlock(entry.content));
        break;
      case 'moderator':
        parts.push('## Moderator', safeBlock(entry.content));
        break;
      case 'end':
        parts.push(`## Ended · ${END_TITLES[entry.reason ?? 'stopped']}`, safeBlock(entry.content));
        break;
      case 'bot': {
        const failed = entry.status === 'error';
        if (!failed) turn++;
        parts.push(`## ${oneLine(entry.name ?? 'Bot')}${failed ? '' : ` · Turn ${turn}`}`);
        if (entry.content) parts.push(safeBlock(entry.content));
        const notes = [
          entry.status ? STATUS_NOTES[entry.status] : undefined,
          failed ? `_(failed: ${oneLine(entry.error ?? 'error')})_` : undefined,
          entry.edited ? '_(edited)_' : undefined,
        ].filter(Boolean);
        if (notes.length > 0) parts.push(notes.join(' '));
        const usage = turnUsageLine(entry.usage, context.isFree(entry.model ?? ''));
        parts.push(`_${[entry.model, usage].filter(Boolean).join(' · ')}_`);
      }
    }
  }
  parts.push('## Totals', totalsLine(conversation, context.limits));
  return `${parts.join('\n\n')}\n`;
}

/** `6 of 20 turns · 1 min 12 s of 5 min · $0.012 of $0.25`. */
export function totalsLine(conversation: Conversation, limits: Limits): string {
  return [
    `${turnCount(conversation)} of ${plural(limits.turns, 'turn')}`,
    `${formatMs(conversation.elapsedMs)} of ${formatMs(limits.timeMs)}`,
    `${conversation.spentApprox ? '≈ ' : ''}${formatUsd(conversation.spentUsd)} of ${formatUsd(limits.costUsd)}`,
  ].join(' · ');
}

export interface ExportedEntry {
  kind: Entry['kind'];
  content: string;
  createdAt: number;
  speaker?: Entry['speaker'];
  name?: string;
  model?: string;
  status?: Entry['status'];
  error?: string;
  outcomeUnknown?: boolean;
  usage?: Entry['usage'];
  trimmed?: number;
  edited?: boolean;
  reason?: Entry['reason'];
}

export interface ExportedConversation {
  format: 'ortoolbox-bot-to-bot';
  version: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  first: Conversation['first'];
  bots: Conversation['bots'];
  limits: { turnLimit: number; timeLimitMs: number; costCapUsd: number; stopPhrase: string };
  totals: { turns: number; elapsedMs: number; costUsd: number; costApproximate: boolean };
  entries: ExportedEntry[];
}

export function toJson(conversation: Conversation, context: ExportContext): ExportedConversation {
  return {
    format: 'ortoolbox-bot-to-bot',
    version: 1,
    id: conversation.id,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    first: conversation.first,
    bots: structuredClone(conversation.bots),
    limits: {
      turnLimit: context.limits.turns,
      timeLimitMs: context.limits.timeMs,
      costCapUsd: context.limits.costUsd,
      stopPhrase: context.limits.stopPhrase,
    },
    totals: {
      turns: turnCount(conversation),
      elapsedMs: conversation.elapsedMs,
      costUsd: conversation.spentUsd,
      costApproximate: conversation.spentApprox,
    },
    entries: conversation.entries.map((entry) => {
      const copy: Partial<Entry> = structuredClone(entry);
      delete copy.id;
      return copy as ExportedEntry;
    }),
  };
}
