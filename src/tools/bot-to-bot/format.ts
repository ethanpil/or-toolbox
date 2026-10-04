/**
 * Text shown for a conversation (in the page, the exports and History's replay): per-turn usage lines, what
 * ended a conversation, avatar initials and the limit summaries.
 */
import { formatCount, formatMs, formatUsd, plural } from '../../ui/format';
import type { StopReason, TurnUsage } from './conversation';
import type { Limits } from './loop';

/** `123 in · 456 out · $0.0012 · 1.4 s`; `free` on a free model, `≈` for estimated or unknown costs. */
export function usageLine(usage: TurnUsage | undefined, free: boolean): string {
  if (!usage) return '';
  const cost =
    free && usage.costUsd === 0 && !usage.costUnknown
      ? 'free'
      : usage.costUnknown && usage.costUsd === 0
        ? 'cost unknown'
        : `${usage.costEstimated || usage.costUnknown ? '≈ ' : ''}${formatUsd(usage.costUsd)}`;
  return [
    `${formatCount(usage.promptTokens)} in · ${formatCount(usage.completionTokens)} out`,
    cost,
    usage.latencyMs > 0 ? formatMs(usage.latencyMs) : null,
  ]
    .filter(Boolean)
    .join(' · ');
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
      return spentUsd >= limits.costUsd
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

/** Elapsed time as a clock: `0:42`, `4:05`, `1:02:09`. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}
