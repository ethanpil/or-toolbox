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
 * Token counts and the context fit are core's (src/core/tokens.ts: `approxTokens`, `promptBudget`, `trimOldest`, `fitContext`),
 * the same for every tool.
 */
import type { ChatMessage, ChatRequest } from '../../core/api/types';
import {
  approxTokens,
  type ContextLimits,
  fitContext,
  MESSAGE_OVERHEAD,
  promptBudget,
  trimOldest,
} from '../../core/tokens';
import { type Conversation, type Entry, isSpoken, type Speaker } from './conversation';

export const MODERATOR_LABEL = '[Moderator]';

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

/** The request for `speaker`'s next turn in `conversation`. */
export function buildTurn(
  conversation: Pick<Conversation, 'entries'>,
  speaker: Speaker,
  options: TurnOptions,
): BuiltTurn {
  const system = framing(speaker, options.bots, options.stopPhrase);
  const { opener, rest } = contextParts(conversation.entries, speaker, options.bots);
  // The framing and the opener always go; the rest is trimmed oldest first to fit what the window leaves.
  const limits: ContextLimits = {
    context: options.contextLength,
    maxTokens: options.maxTokens,
    maxCompletionTokens: options.maxCompletionTokens,
    fixed: approxTokens(system) + MESSAGE_OVERHEAD + (opener?.tokens ?? 0),
  };
  const trimmed = trimOldest(
    rest.map((item) => item.tokens),
    promptBudget(limits),
  );
  const kept = rest.slice(trimmed);
  const keptTokens = kept.reduce((sum, item) => sum + item.tokens, 0);
  const fit = fitContext({ ...limits, prompt: keptTokens });
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...mergeParts(opener ? [opener, ...kept] : kept),
  ];
  return {
    body: {
      model: options.model,
      messages,
      ...(fit.maxTokens !== null ? { max_tokens: fit.maxTokens } : {}),
    },
    trimmed,
    promptTokens: (limits.fixed ?? 0) + keptTokens,
    completionTokens: fit.completionTokens,
    tooLong: fit.tooLong,
  };
}
