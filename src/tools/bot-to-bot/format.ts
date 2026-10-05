/**
 * Text shown for a conversation (in the page, the exports and History's replay): per-turn usage lines, what
 * ended a conversation, avatar initials and the limit summaries.
 */
import { formatMs, formatUsd, plural, usageLine } from '../../ui/format';
import type { StopReason, TurnUsage } from './conversation';
import { capReached, type Limits } from './loop';

/**
 * A turn's `123 in · 456 out · $0.0012 · 1.4 s`, worded by the shared cost rule (`usageLine`). A turn whose cost is
 * unknown holds what was counted for it (its estimate) in `costUsd`: "cost unknown (≈ $0.0021 counted)".
 */
export function turnUsageLine(usage: TurnUsage | undefined, free: boolean): string {
  return usageLine(usage, { free, booked: usage?.costUnknown ? usage.costUsd : null });
}

/** What ended a conversation, as one sentence (the end marker, the status line, the exports). */
export function endText(
  reason: StopReason,
  details: { limits: Limits; spentUsd: number; speakerName?: string },
): string {
  const { limits, spentUsd } = details;
  switch (reason) {
    case 'turns':
      return `Turn limit reached (${plural(limits.turns, 'turn')}).`;
    case 'time':
      return `Time limit reached (${formatMs(limits.timeMs)}).`;
    case 'cost':
      return capReached(spentUsd, limits.costUsd)
        ? `Cost cap reached: ${formatUsd(spentUsd)} spent of ${formatUsd(limits.costUsd)}.`
        : `Cost cap: the next turn could pass ${formatUsd(limits.costUsd)} (${formatUsd(spentUsd)} spent).`;
    case 'phrase':
      return `${details.speakerName ?? 'A bot'} said ${limits.stopPhrase.trim()}.`;
    case 'stopped':
      return 'Stopped by you.';
  }
}

/** Short labels for the end marker's heading. */
export const END_TITLES: Readonly<Record<StopReason, string>> = {
  turns: 'Turn limit',
  time: 'Time limit',
  cost: 'Cost cap',
  phrase: 'Stop phrase',
  stopped: 'Stopped',
};

/** One or two letters for an avatar: the first letters of two words, else the first two letters of one. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = (word: string): string[] => Array.from(word);
  if (words.length > 1) {
    return (letters(words[0]!)[0]! + letters(words[1]!)[0]!).toUpperCase();
  }
  const chars = letters(words[0]!);
  return (chars[0]!.toUpperCase() + (chars[1] ?? '').toLowerCase()).trim();
}
