/**
 * Drawing the arena's output from round data: a contender panel (title, status, the streamed answer, an error
 * with Retry, the metrics), the vote bar, the comparison table and the vote tally. arena.ts decides when.
 *
 * A panel is built once per round and updated in place (`update()`), so the answer that streams into it is never
 * rebuilt and a focused Retry or answer region keeps focus; the comparison and tally tables keep their scroll
 * region and redraw only their rows. Before names are shown (`round.revealed`), nothing that tells the models
 * apart is drawn: no name, no cost, no "Cheapest", and errors in `failureText(error, { blind: true })`'s words
 * (true for any model, the same note, link and Retry on every failed panel); the real wording after the reveal.
 */
import { dataTable } from '../../ui/components/data-table';
import { emptyState } from '../../ui/components/empty-state';
import { externalLink } from '../../ui/components/external-link';
import { type MarkdownStream, streamMarkdown } from '../../ui/components/stream-markdown';
import { h } from '../../ui/dom';
import type { FailureText } from '../../ui/feedback/errors';
import { formatInt, formatMs, formatRunCost } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { formatRate } from './export';
import {
  allIn,
  canVote,
  cutOff,
  entryAt,
  type Entry,
  hasAnswer,
  type Metrics,
  metricsOf,
  panelLabel,
  panelLetter,
  type Round,
  summary,
} from './round';
import { type Tally, tallyRows } from './tally';

export interface Naming {
  /** A model's display name (its id until the catalog is in). */
  name: (id: string) => string;
  isFree: (id: string) => boolean;
}

const STATUS: Readonly<Record<Entry['status'], { text: string; tone: string }>> = {
  waiting: { text: 'Waiting', tone: 'text-bg-secondary' },
  streaming: { text: 'Answering…', tone: 'text-bg-primary' },
  done: { text: 'Done', tone: 'text-bg-success' },
  stopped: { text: 'Stopped', tone: 'text-bg-warning' },
  error: { text: 'Failed', tone: 'text-bg-danger' },
};

/** A metric's value as the panels and the table show it. */
const show = (value: number | null, format: (value: number) => string): string =>
  value === null ? '—' : format(value);

/** Cost, hidden before names are shown (a free model's $0 would give it away); else the shared wording. */
function costText(metrics: Metrics, entry: Entry, round: Round, naming: Naming): string {
  if (!round.revealed) return 'Hidden';
  return formatRunCost(metrics, { free: naming.isFree(entry.model) });
}

export interface PanelView {
  readonly element: HTMLElement;
  /** The answer region (focusable: it scrolls). */
  readonly answer: HTMLElement;
  /** Starts a fresh answer (a placeholder until the first token) and returns the stream that draws it. */
  begin(): MarkdownStream;
  /** Redraws the header, status, error and metrics from the round; the answer belongs to the stream. */
  update(): void;
  /** The answer is complete (or stopped, or failed): final render, and a note when nothing arrived. */
  end(): Promise<void>;
}

export interface PanelOptions {
  round: Round;
  panel: number;
  naming: Naming;
  /** The Retry button for a failed contender (entry index), bound to the runner by the caller. */
  retryButton: (index: number) => HTMLElement;
}

export function panelView(options: PanelOptions): PanelView {
  const { round, panel, naming } = options;
  const letter = panelLetter(panel);
  const titleId = uid('panel-title');
  const status = h('span', {
    class: 'badge rounded-pill ms-auto flex-shrink-0',
    'data-testid': 'panel-status',
  });
  const pick = h(
    'span',
    { class: 'badge rounded-pill text-bg-primary flex-shrink-0', hidden: true },
    icon('trophy'),
    ' Your pick',
  );
  const model = h('div', {
    class: 'small text-body-secondary text-truncate',
    'data-testid': 'panel-model',
  });
  const answer = h('div', {
    class: 'or-arena-answer or-markdown',
    role: 'region',
    'aria-label': `${panelLabel(panel)} answer`,
    'aria-busy': 'false',
    tabIndex: 0,
    'data-testid': 'panel-answer',
  });
  const problem = h('div', { class: 'empty-hidden' });
  const cutNote = h(
    'p',
    { class: 'small text-warning-emphasis mb-0', hidden: true, 'data-testid': 'panel-cutoff' },
    'Cut off at the length limit.',
  );
  const metrics = h('dl', { class: 'or-arena-metrics mb-0', 'data-testid': 'panel-metrics' });
  const card = h(
    'section',
    {
      class: 'card h-100 or-arena-panel',
      'aria-labelledby': titleId,
      'data-testid': 'arena-panel',
      'data-panel': letter,
    },
    h(
      'div',
      { class: 'card-header d-flex align-items-center gap-2' },
      h('span', { class: 'or-arena-letter', 'aria-hidden': 'true' }, letter),
      h(
        'div',
        { class: 'min-w-0' },
        h('h4', { id: titleId, class: 'h6 mb-0', 'data-testid': 'panel-title' }, panelLabel(panel)),
        model,
      ),
      pick,
      status,
    ),
    h('div', { class: 'card-body d-flex flex-column gap-2' }, answer, cutNote, problem),
    h('div', { class: 'card-footer' }, metrics),
  );

  let stream: MarkdownStream | null = null;
  /** The placeholder shown until the first token (the stream replaces it), or null. */
  let waiting: HTMLElement | null = null;
  /** What the error block shows ('' for none): it is rebuilt only when this changes. */
  let problemShown = '';

  const placeholder = (text: string): HTMLElement =>
    h(
      'div',
      { class: 'placeholder-glow', 'data-testid': 'panel-waiting' },
      h('span', { class: 'visually-hidden' }, text),
      ['col-9', 'col-11', 'col-6'].map((width) =>
        h('span', { class: `placeholder ${width} d-block mb-2 rounded`, 'aria-hidden': 'true' }),
      ),
      h('span', { class: 'small text-body-secondary', 'aria-hidden': 'true' }, text),
    );

  const metric = (label: string, value: string, testId: string): HTMLElement =>
    h(
      'div',
      { class: 'or-arena-metric' },
      h('dt', null, label),
      h('dd', { 'data-testid': testId }, value),
    );

  const update = (): void => {
    const entry = entryAt(round, panel);
    const index = round.order[panel]!;
    const look = STATUS[entry.status];
    status.className = `badge rounded-pill ms-auto flex-shrink-0 ${look.tone}`;
    status.textContent =
      entry.status === 'streaming' && entry.thinking && !entry.text ? 'Thinking…' : look.text;
    pick.hidden = !(round.vote?.kind === 'winner' && round.vote.panel === panel);
    card.classList.toggle('is-pick', !pick.hidden);
    const name = naming.name(entry.model);
    if (round.revealed) {
      const served =
        entry.servedModel && entry.servedModel !== entry.model
          ? ` · via ${naming.name(entry.servedModel)}`
          : '';
      model.textContent = `${name}${served}`;
      model.title = entry.model;
    } else {
      model.textContent = 'Name hidden until you vote';
      model.removeAttribute('title');
    }
    answer.setAttribute('aria-busy', String(entry.status === 'streaming'));
    // While waiting for the first token the placeholder says what is going on.
    if (waiting?.isConnected && !entry.text && entry.status === 'streaming' && entry.thinking) {
      const thinking = placeholder('Thinking…');
      waiting.replaceWith(thinking);
      waiting = thinking;
    }

    cutNote.hidden = !cutOff(entry);

    // The error block is rebuilt only when what it says changes, so a focused Retry survives other updates.
    const failure =
      entry.status === 'error' && entry.failure
        ? round.revealed
          ? entry.failure.shown
          : entry.failure.blind
        : null;
    const shown = failure ? JSON.stringify(failure) : '';
    if (shown !== problemShown) {
      problemShown = shown;
      problem.replaceChildren(failure ? errorBlock(failure, index) : '');
    }

    const values = metricsOf(entry);
    metrics.replaceChildren(
      metric('First token', show(values.ttftMs, formatMs), 'metric-ttft'),
      metric('Total', show(values.totalMs, formatMs), 'metric-total'),
      metric('Tokens', show(values.completionTokens, formatInt), 'metric-tokens'),
      metric('Tokens/s', show(values.tokensPerSecond, formatRate), 'metric-rate'),
      metric('Cost', costText(values, entry, round, naming), 'metric-cost'),
    );
  };

  /**
   * `text`, then `note` (blind: the same sentence on every failed panel), then the activity link when there is one.
   * Retry unless a paid request may have gone through (never the case while blind, so a missing Retry gives
   * nothing away).
   */
  const errorBlock = (failure: FailureText, index: number): HTMLElement =>
    h(
      'div',
      {
        class: 'alert alert-danger d-flex align-items-start gap-2 py-2 px-3 mb-0 small',
        'data-testid': 'panel-error',
      },
      icon('exclamation-octagon', 'mt-1'),
      h(
        'div',
        { class: 'd-flex flex-column align-items-start gap-2 min-w-0' },
        h('span', null, failure.note ? `${failure.text} ${failure.note}` : failure.text),
        h(
          'div',
          { class: 'd-flex flex-wrap align-items-center gap-2' },
          failure.activityUrl
            ? externalLink(failure.activityUrl, 'OpenRouter activity', 'alert-link')
            : null,
          failure.outcomeUnknown ? null : options.retryButton(index),
        ),
      ),
    );

  return {
    element: card,
    answer,
    begin() {
      stream?.dispose();
      waiting = placeholder('Waiting for the first token…');
      answer.replaceChildren(waiting);
      stream = streamMarkdown(answer);
      return stream;
    },
    update,
    async end() {
      await stream?.finish();
      const entry = entryAt(round, panel);
      if (!entry.text) {
        answer.replaceChildren(
          h(
            'p',
            { class: 'small text-body-secondary mb-0', 'data-testid': 'panel-empty' },
            entry.status === 'error'
              ? 'No answer.'
              : entry.status === 'stopped'
                ? 'Stopped before any text arrived.'
                : 'The model returned no text.',
          ),
        );
      }
      update();
    },
  };
}

// --- vote bar -------------------------------------------------------------------------------------------------

export interface VoteActions {
  winner: (panel: number) => void;
  tie: () => void;
  bad: () => void;
  reveal: () => void;
}

/** The vote buttons, or what the round ended with. Focus keys name the choice (`vote:A`). */
export function voteBar(round: Round, naming: Naming, actions: VoteActions): HTMLElement[] {
  const titleId = uid('vote-title');
  const vote = round.vote;
  if (vote || (round.revealed && round.settings.blind)) {
    const text = !vote
      ? 'Names revealed without a vote. This round adds nothing to your tally.'
      : vote.kind === 'winner'
        ? `You picked ${panelLabel(vote.panel)}: ${naming.name(entryAt(round, vote.panel).model)}.`
        : vote.kind === 'tie'
          ? 'You called it a tie.'
          : 'You rated every answer as bad.';
    return [
      h(
        'p',
        {
          class: 'or-arena-verdict d-flex align-items-center gap-2 mb-0',
          tabIndex: -1,
          'data-focus-key': 'vote:result',
          'data-testid': 'vote-result',
        },
        icon(vote ? 'check-circle-fill' : 'eye', vote ? 'text-success' : 'text-body-secondary'),
        text,
      ),
    ];
  }
  const open = canVote(round);
  const off = (button: HTMLButtonElement, disabled: boolean): HTMLButtonElement => {
    button.setAttribute('aria-disabled', String(disabled));
    button.classList.toggle('disabled', disabled);
    return button;
  };
  const choice = (
    label: string,
    key: string,
    style: string,
    disabled: boolean,
    onclick: () => void,
    testId: string,
  ): HTMLButtonElement =>
    off(
      h(
        'button',
        {
          type: 'button',
          class: `btn btn-sm ${style}`,
          'data-focus-key': `vote:${key}`,
          'data-testid': testId,
          onclick: () => {
            if (canVote(round) && !disabled) onclick();
          },
        },
        label,
      ),
      disabled,
    );
  return [
    h(
      'div',
      { role: 'group', 'aria-labelledby': titleId, class: 'd-flex flex-column gap-2' },
      h(
        'h3',
        { id: titleId, class: 'h6 mb-0' },
        round.settings.blind ? 'Which answer is best?' : 'Which answer is best? (names shown)',
      ),
      h(
        'p',
        { class: 'small text-body-secondary mb-0', 'data-testid': 'vote-hint' },
        !allIn(round)
          ? 'Voting opens when every answer is in.'
          : open
            ? round.settings.blind
              ? 'Names and costs show after you vote. Your vote goes into the tally below.'
              : 'Your vote goes into the tally below.'
            : 'No answer arrived, so there is nothing to vote on.',
      ),
      h(
        'div',
        { class: 'd-flex flex-wrap gap-2' },
        round.order.map((_, panel) =>
          choice(
            panelLabel(panel),
            panelLetter(panel),
            'btn-outline-primary',
            !open || !hasAnswer(entryAt(round, panel)),
            () => actions.winner(panel),
            'vote-panel',
          ),
        ),
        choice('Tie', 'tie', 'btn-outline-secondary', !open, actions.tie, 'vote-tie'),
        choice('All bad', 'bad', 'btn-outline-secondary', !open, actions.bad, 'vote-bad'),
        round.settings.blind
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-sm btn-link ms-sm-auto',
                'data-focus-key': 'vote:reveal',
                'data-testid': 'vote-reveal',
                onclick: actions.reveal,
              },
              'Reveal without voting',
            )
          : null,
      ),
    ),
  ];
}

// --- comparison table --------------------------------------------------------------------------------------------

export interface TableView<T> {
  readonly element: HTMLElement;
  /** Redraws the rows; the scroll region stays, so focus and scroll position do too. */
  update(value: T): void;
}

export function comparisonTable(naming: Naming): TableView<Round> {
  const body = h('tbody');
  const element = dataTable({
    scrollerLabel: 'Comparison of the answers',
    caption:
      'Time to first token, total time, output tokens, tokens per second and cost per answer',
    head: ['Answer', 'First token', 'Total', 'Tokens', 'Tokens/s', 'Cost'],
    numericFrom: 1,
    body,
    class: 'table table-sm align-middle mb-0',
    testId: 'compare-table',
  });
  return { element, update: (round) => body.replaceChildren(...comparisonRows(round, naming)) };
}

function comparisonRows(round: Round, naming: Naming): HTMLElement[] {
  return summary(round).map((row) => {
    const label = panelLabel(row.panel);
    return h(
      'tr',
      { 'data-testid': 'compare-row' },
      h(
        'th',
        { scope: 'row', class: 'fw-normal' },
        h('span', { class: 'fw-semibold' }, label),
        round.revealed
          ? h('span', { class: 'd-block small text-body-secondary' }, naming.name(row.entry.model))
          : null,
        h(
          'span',
          { class: 'd-flex flex-wrap gap-1' },
          row.fastest
            ? h(
                'span',
                { class: 'badge rounded-pill text-bg-primary', 'data-testid': 'badge-fastest' },
                'Fastest',
              )
            : null,
          row.cheapest && round.revealed
            ? h(
                'span',
                { class: 'badge rounded-pill text-bg-success', 'data-testid': 'badge-cheapest' },
                'Cheapest',
              )
            : null,
        ),
      ),
      [
        show(row.metrics.ttftMs, formatMs),
        show(row.metrics.totalMs, formatMs),
        show(row.metrics.completionTokens, formatInt),
        show(row.metrics.tokensPerSecond, formatRate),
        costText(row.metrics, row.entry, round, naming),
      ].map((value) => h('td', { class: 'text-end text-nowrap' }, value)),
    );
  });
}

// --- tally ---------------------------------------------------------------------------------------------------

/** The tally table, or "No votes yet" while it is empty. */
export function tallyView(naming: Naming): TableView<Tally> {
  const body = h('tbody');
  const table = dataTable({
    scrollerLabel: 'Your votes per model',
    caption: 'Wins, ties and rounds per model from your votes',
    head: ['Model', 'Wins', 'Ties', 'Rounds'],
    numericFrom: 1,
    body,
    class: 'table table-sm align-middle mb-0',
    testId: 'tally-table',
  });
  const empty = emptyState({
    icon: 'bar-chart',
    title: 'No votes yet',
    text: 'Vote after a round: wins per model add up here, in this browser only.',
    inline: true,
    testId: 'tally-empty',
  });
  return {
    element: h('div', null, empty, table),
    update(tally) {
      const rows = tallyRows(tally);
      empty.hidden = rows.length > 0;
      table.hidden = rows.length === 0;
      body.replaceChildren(
        ...rows.map((row) =>
          h(
            'tr',
            { 'data-testid': 'tally-row' },
            h(
              'th',
              { scope: 'row', class: 'fw-normal' },
              h('span', { title: row.model }, naming.name(row.model)),
            ),
            [row.wins, row.ties, row.rounds].map((value) =>
              h('td', { class: 'text-end' }, String(value)),
            ),
          ),
        ),
      );
    },
  };
}
