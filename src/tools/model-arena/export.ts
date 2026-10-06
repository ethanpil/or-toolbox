/**
 * A round as Markdown or JSON: the prompt and settings, each panel's model, answer and metrics, and the vote.
 * Offered only once the names are shown and every answer is in (`exportReady`). Attachments are listed by name;
 * their bytes are never exported. Text a model or the user wrote (answers, the prompt, the system prompt) goes
 * through `safeBlock`: a code fence left open is closed and nothing in it can pass for a section of the export.
 */
import { formatInt, formatMs, formatRunCost } from '../../ui/format';
import { safeBlock } from '../../ui/markdown-safe';
import {
  cutOff,
  entryAt,
  type Metrics,
  metricsOf,
  panelLabel,
  panelLetter,
  type Round,
} from './round';

/** `12.3 tok/s` style rate: one decimal below 100. */
export const formatRate = (perSecond: number): string =>
  perSecond < 100 ? perSecond.toFixed(1) : String(Math.round(perSecond));

const cell = (value: number | null, format: (value: number) => string): string =>
  value === null ? '—' : format(value);

/** One line of the vote, e.g. "Model B (Llama 4) won." */
export function voteLine(round: Round, name: (id: string) => string): string {
  const vote = round.vote;
  if (!vote)
    return round.revealed && round.settings.blind ? 'Revealed without a vote.' : 'No vote.';
  if (vote.kind === 'tie') return 'Tie.';
  if (vote.kind === 'bad') return 'All bad.';
  const entry = entryAt(round, vote.panel);
  return `${panelLabel(vote.panel)} (${name(entry.model)}) won.`;
}

export function roundMarkdown(
  round: Round,
  name: (id: string) => string,
  isFree: (id: string) => boolean = () => false,
): string {
  const parts: string[] = [
    '# Model arena round',
    '## Prompt',
    round.prompt ? safeBlock(round.prompt) : '_(no text)_',
  ];
  if (round.attachments.length > 0) {
    parts.push(`_Attachments: ${round.attachments.map((file) => file.name).join(', ')}_`);
  }
  if (round.settings.system.trim()) {
    parts.push(`**System prompt:**\n\n${safeBlock(round.settings.system.trim())}`);
  }
  if (round.settings.temperature !== null) {
    parts.push(`**Temperature:** ${round.settings.temperature}`);
  }
  if (round.settings.maxTokens !== null) {
    parts.push(`**Max tokens:** ${round.settings.maxTokens}`);
  }
  round.order.forEach((_, panel) => {
    const entry = entryAt(round, panel);
    const metrics = metricsOf(entry);
    parts.push(`## ${panelLabel(panel)}: ${name(entry.model)} (\`${entry.model}\`)`);
    if (entry.text) parts.push(safeBlock(entry.text));
    if (cutOff(entry)) parts.push('_(cut off at the length limit)_');
    if (entry.status === 'stopped') parts.push('_(stopped)_');
    if (entry.status === 'error') {
      parts.push(`_(failed: ${entry.failure?.shown.text ?? 'error'})_`);
    }
    parts.push(
      [
        '| First token | Total | Output tokens | Tokens/s | Cost |',
        '| --- | --- | --- | --- | --- |',
        `| ${cell(metrics.ttftMs, formatMs)} | ${cell(metrics.totalMs, formatMs)} | ${cell(metrics.completionTokens, formatInt)} | ${cell(metrics.tokensPerSecond, formatRate)} | ${formatRunCost(metrics, { free: isFree(entry.model), booked: metrics.bookedUsd })} |`,
      ].join('\n'),
    );
  });
  parts.push('## Vote', voteLine(round, name));
  return `${parts.join('\n\n')}\n`;
}

export interface ExportedRound {
  startedAt: string;
  prompt: string;
  system: string;
  temperature: number | null;
  maxTokens: number | null;
  blind: boolean;
  attachments: { name: string; type: string; size: number }[];
  contenders: {
    panel: string;
    model: string;
    servedModel?: string;
    status: string;
    answer: string;
    /** The answer stopped at the length limit (`finish_reason` "length"). */
    cutOff: boolean;
    error?: string;
    metrics: Metrics;
  }[];
  vote:
    { kind: 'winner'; panel: string; model: string } | { kind: 'tie' } | { kind: 'all-bad' } | null;
}

export function roundJson(round: Round): ExportedRound {
  const vote = round.vote;
  return {
    startedAt: new Date(round.startedAt).toISOString(),
    prompt: round.prompt,
    system: round.settings.system,
    temperature: round.settings.temperature,
    maxTokens: round.settings.maxTokens,
    blind: round.settings.blind,
    attachments: round.attachments.map(({ name, type, size }) => ({ name, type, size })),
    contenders: round.order.map((_, panel) => {
      const entry = entryAt(round, panel);
      return {
        panel: panelLetter(panel),
        model: entry.model,
        ...(entry.servedModel ? { servedModel: entry.servedModel } : {}),
        status: entry.status,
        answer: entry.text,
        cutOff: cutOff(entry),
        ...(entry.failure ? { error: entry.failure.shown.text } : {}),
        metrics: metricsOf(entry),
      };
    }),
    vote: !vote
      ? null
      : vote.kind === 'winner'
        ? {
            kind: 'winner',
            panel: panelLetter(vote.panel),
            model: entryAt(round, vote.panel).model,
          }
        : vote.kind === 'tie'
          ? { kind: 'tie' }
          : { kind: 'all-bad' },
  };
}
