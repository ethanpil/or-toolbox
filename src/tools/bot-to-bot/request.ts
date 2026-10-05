/**
 * What one bot is sent for its turn.
 *
 * - **Framing** (the system message): the bot's persona, then a generated line naming itself and the other bot,
 *   saying where moderator messages come from and, with a stop phrase set, asking it to end its message with the
 *   phrase once the conversation is finished. The page shows it read-only, so nothing is hidden.
 * - **Roles:** the bot's own turns are `assistant` messages; the other bot's turns, the opening prompt and moderator
 *   messages are `user` messages. Moderator text is marked `[Moderator] …`. Consecutive messages of one role are
 *   merged (some providers require alternation); inside a merged user message every part is labelled with who said
 *   it (`[Moderator]`, `[Bot A]`), so the bot can tell them apart.
 * - **Trimming:** when the context window nears, the oldest entries after the opening prompt are left out first;
 *   the framing and the opener always stay, and so does the entry being answered. `trimmed` says how many went.
 * - **`max_tokens`** is clamped as in Chat: to the model's output cap and to what the context leaves.
 *
 * Token counts use the shared approximation (src/core/tokens.ts), deliberately high.
 */
import type { ChatMessage, ChatRequest } from '../../core/api/types';
import { approxTokens } from '../../core/tokens';
import { type Conversation, type Entry, isSpoken, type Speaker } from './conversation';

export const MODERATOR_LABEL = '[Moderator]';

/** Output assumed by estimates and kept free in the context when Max tokens is not set (as in Chat). */
export const DEFAULT_OUTPUT_TOKENS = 4096;

/** Per-message overhead (role markers) in the token approximation. */
const MESSAGE_OVERHEAD = 4;

export interface BotProfile {
  name: string;
  persona: string;
}

/** The generated part of a bot's framing. */
export function framingLine(self: string, otherName: string, stopPhrase: string): string {
  const phrase = stopPhrase.trim();
  return [
    `You are ${self}, in a conversation with ${otherName}. ${otherName}'s messages reach you as the user's; text marked ${MODERATOR_LABEL} comes from the person moderating the conversation.`,
    phrase ? `When you think the conversation is finished, end your message with ${phrase}.` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** The whole system message of a bot: its persona, then the generated line. */
export function framing(
  speaker: Speaker,
  bots: Record<Speaker, BotProfile>,
  stopPhrase: string,
): string {
  const self = bots[speaker];
  const otherBot = bots[speaker === 'a' ? 'b' : 'a'];
  const persona = self.persona.trim();
  const line = framingLine(self.name, otherBot.name, stopPhrase);
  return persona ? `${persona}\n\n${line}` : line;
}

/** One entry as the speaker sees it, before merging. */
export interface ContextPart {
  role: 'user' | 'assistant';
  /** Who said it, for labels: `[Moderator]` or the other bot's name; null for the speaker's own turn. */
  label: string | null;
  moderator: boolean;
  text: string;
  tokens: number;
}

function part(
  entry: Entry,
  speaker: Speaker,
  bots?: Record<Speaker, BotProfile>,
): ContextPart | null {
  if (entry.kind === 'opener' || entry.kind === 'moderator') {
    const text = entry.content;
    return {
      role: 'user',
      label: MODERATOR_LABEL,
      moderator: true,
      text,
      tokens: approxTokens(text) + 3 + MESSAGE_OVERHEAD,
    };
  }
  if (!isSpoken(entry) || !entry.content.trim()) return null;
  const own = entry.speaker === speaker;
  // The other bot by its current name, as its framing names it (a rename applies to what came before).
  const name = (entry.speaker && bots?.[entry.speaker].name) || entry.name || '';
  const label = own ? null : `[${name}]`;
  return {
    role: own ? 'assistant' : 'user',
    label,
    moderator: false,
    text: entry.content,
    tokens: approxTokens(entry.content) + (label ? approxTokens(label) + 1 : 0) + MESSAGE_OVERHEAD,
  };
}

/**
 * The opening prompt's part and the parts after it, as `speaker` sees them (end markers and failures left out).
 * `bots` gives the current names for the labels; without it, the names the turns were spoken under.
 */
export function contextParts(
  entries: readonly Entry[],
  speaker: Speaker,
  bots?: Record<Speaker, BotProfile>,
): { opener: ContextPart | null; rest: ContextPart[] } {
  let opener: ContextPart | null = null;
  const rest: ContextPart[] = [];
  for (const entry of entries) {
    const next = part(entry, speaker, bots);
    if (!next) continue;
    if (entry.kind === 'opener') opener = next;
    else rest.push(next);
  }
  return { opener, rest };
}

/**
 * Merges consecutive parts of one role into one message. A user message made of one part shows moderator text
 * marked and a bot's text as it is; one made of several labels every part.
 */
export function mergeParts(parts: readonly ContextPart[]): ChatMessage[] {
  const groups: ContextPart[][] = [];
  for (const next of parts) {
    const last = groups.at(-1);
    if (last && last[0]!.role === next.role) last.push(next);
    else groups.push([next]);
  }
  return groups.map((group): ChatMessage => {
    const role = group[0]!.role;
    if (role === 'assistant') {
      return { role, content: group.map((item) => item.text).join('\n\n') };
    }
    const labelled = group.length > 1;
    return {
      role,
      content: group
        .map((item) =>
          item.label && (labelled || item.moderator) ? `${item.label} ${item.text}` : item.text,
        )
        .join('\n\n'),
    };
  });
}

/**
 * How many of `tokens` (oldest first) to leave out so the rest fits `budget`; the last is always kept.
 */
export function trimCount(tokens: readonly number[], budget: number): number {
  let total = tokens.reduce((sum, value) => sum + value, 0);
  let dropped = 0;
  while (dropped < tokens.length - 1 && total > budget) total -= tokens[dropped++]!;
  return dropped;
}

export interface TurnOptions {
  model: string;
  bots: Record<Speaker, BotProfile>;
  stopPhrase: string;
  /** Max tokens per turn; null = the model's default. */
  maxTokens: number | null;
  /** The model's context window in tokens; null = unknown (nothing is trimmed). */
  contextLength: number | null;
  /** The model's own output cap: `max_tokens` never exceeds it. */
  maxCompletionTokens: number | null;
}

export interface BuiltTurn {
  body: ChatRequest;
  /** Entries after the opener left out to fit the context window. */
  trimmed: number;
  /** Approximate prompt tokens of what is sent. */
  promptTokens: number;
  /** The output tokens an estimate should assume. */
  completionTokens: number;
  /** Even the framing, the opener and the last entry alone do not fit: do not send. */
  tooLong: boolean;
}

/** The output a turn may take: the setting, else the default, within the model's cap. */
export function outputTokens(maxTokens: number | null, maxCompletionTokens: number | null): number {
  const cap =
    maxCompletionTokens && maxCompletionTokens > 0 ? maxCompletionTokens : Number.POSITIVE_INFINITY;
  return Math.min(maxTokens ?? DEFAULT_OUTPUT_TOKENS, cap);
}

/** The request for `speaker`'s next turn in `conversation`. */
export function buildTurn(
  conversation: Pick<Conversation, 'entries'>,
  speaker: Speaker,
  options: TurnOptions,
): BuiltTurn {
  const system = framing(speaker, options.bots, options.stopPhrase);
  const systemTokens = approxTokens(system) + MESSAGE_OVERHEAD;
  const { opener, rest } = contextParts(conversation.entries, speaker, options.bots);
  const fixed = systemTokens + (opener?.tokens ?? 0);
  const cap =
    options.maxCompletionTokens && options.maxCompletionTokens > 0
      ? options.maxCompletionTokens
      : Number.POSITIVE_INFINITY;
  let maxTokens = options.maxTokens === null ? null : Math.min(options.maxTokens, cap);
  const wanted = outputTokens(options.maxTokens, options.maxCompletionTokens);

  let trimmed = 0;
  let tooLong = false;
  let completionTokens = wanted;
  const context = options.contextLength;
  const tokens = rest.map((item) => item.tokens);
  if (context && context > 0) {
    // Leave room for the answer and a margin for the approximation.
    const budget = Math.floor(context * 0.95) - Math.min(wanted, Math.floor(context / 2)) - fixed;
    trimmed = trimCount(tokens, budget);
    const kept = tokens.slice(trimmed).reduce((sum, value) => sum + value, 0);
    tooLong = kept > budget;
    // The prompt and the answer together must fit the window.
    const room = Math.max(1, context - fixed - kept);
    if (maxTokens !== null) maxTokens = Math.min(maxTokens, room);
    completionTokens = Math.min(wanted, room);
  }
  const kept = rest.slice(trimmed);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...mergeParts(opener ? [opener, ...kept] : kept),
  ];
  return {
    body: {
      model: options.model,
      messages,
      ...(maxTokens !== null ? { max_tokens: maxTokens } : {}),
    },
    trimmed,
    promptTokens: fixed + kept.reduce((sum, item) => sum + item.tokens, 0),
    completionTokens,
    tooLong,
  };
}
