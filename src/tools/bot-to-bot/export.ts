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
import { type Conversation, type Entry, turnCount } from './conversation';
import { END_TITLES, turnUsageLine } from './format';
import type { Limits } from './loop';

export interface ExportContext {
  limits: Limits;
  isFree: (model: string) => boolean;
}

/** An opening code fence: up to 3 spaces, then 3 or more backticks or tildes (CommonMark). */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** An ATX heading. */
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** A thematic break or a setext underline: `---`, `***`, `___` (spaces allowed), `===`, a lone `-` or `=`. */
const RULE = /^ {0,3}(?:([-*_])(?:[ \t]*\1){2,}|-+|=+)[ \t]*$/;
/** HTML blocks that run on until a terminator rather than a blank line (CommonMark types 1 to 5). */
const LONG_HTML = /^ {0,3}<(?:script|pre|style|textarea|!--|\?|![A-Za-z]|!\[CDATA\[)/i;

/** One line outside code, with anything that would act as transcript structure escaped. */
function escapeStructure(line: string): string {
  if (HEADING.test(line)) return line.replace('#', '\\#');
  if (RULE.test(line)) return line.replace(/[-*_=]/, (char) => `\\${char}`);
  if (LONG_HTML.test(line)) return line.replace('<', '\\<');
  return line;
}

interface OpenFence {
  char: string;
  length: number;
}

/**
 * Text from a bot or the moderator, made safe to place between the transcript's headings: a code fence left
 * open is closed (same character, as long as the opener), and outside code, headings, rules, setext underlines
 * and long HTML blocks are escaped. Code inside fences stays exactly as written.
 */
export function safeBlock(text: string): string {
  let open: OpenFence | null = null;
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const fence = FENCE.exec(line);
    if (open) {
      const marker = fence?.[1] ?? '';
      if (marker[0] === open.char && marker.length >= open.length && !fence?.[2]?.trim()) {
        open = null;
      }
      lines.push(line);
    } else if (fence && !(fence[1]![0] === '`' && fence[2]!.includes('`'))) {
      // (A backtick fence's info string may not contain backticks: that line is inline code.)
      open = { char: fence[1]![0]!, length: fence[1]!.length };
      lines.push(line);
    } else {
      lines.push(escapeStructure(line));
    }
  }
  if (open) lines.push(open.char.repeat(open.length));
  return lines.join('\n');
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
