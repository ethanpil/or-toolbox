/**
 * The results zone: one card per question with the answer drawn for the eye (a probability meter for Yes/No, a bar
 * per option for Choice, a scale with a marker for Score) and written out for everything else (every probability
 * and score is text on the card; the drawings are hidden from assistive technology so nothing is read twice).
 * Each card shows its confidence, its threshold and a badge, "Clear" or "Needs review".
 *
 * Fills grow once, when the answers arrive; they are CSS transitions on `transform`, which `_motion.scss` turns
 * off under the OS preference and the Reduced motion setting, so nothing here checks for either. Re-labelling
 * after a threshold changes edits the badges in place: nothing is redrawn, nothing animates again.
 */
import { formatUsd, plural } from '../../ui/format';
import { emptyState } from '../../ui/components/empty-state';
import { h, replace } from '../../ui/dom';
import { icon } from '../../ui/icon';
import {
  type ConfidenceBasis,
  type DecisionResult,
  formatPercent,
  formatScore,
  type LevelBar,
  type OptionBar,
  type QuestionResult,
  resultVerdict,
  type Verdict,
} from './results';
import { type QuestionDef, TYPE_LABELS } from './schema';

export interface ResultsView {
  readonly element: HTMLElement;
  /** Where the tool puts its Download and Copy buttons (beside the summary). */
  readonly actions: HTMLElement;
  /** Draws a run's answers for the questions that were asked, labelled against their thresholds. */
  show(result: DecisionResult, questions: readonly QuestionDef[]): void;
  /** Re-labels the shown answers against the thresholds now in the form (by question id); redraws nothing. */
  relabel(thresholds: ReadonlyMap<string, number>): void;
  /** A run is on: the answers shown are about to be replaced. */
  busy(on: boolean): void;
  hasResults(): boolean;
}

const BASIS_TEXT: Record<ConfidenceBasis, string> = {
  sides: 'the stronger of Yes and No',
  reported: '',
  'top-probability': 'the highest probability',
};

const VERDICT_TEXT: Record<Verdict, string> = { clear: 'Clear', review: 'Needs review' };

/** Grows a fill from empty to `ratio` (0 to 1) on the next frames, so the transition has something to run from. */
function grow(fill: HTMLElement, ratio: number): void {
  const value = String(Math.min(1, Math.max(0, ratio)));
  fill.style.setProperty('--or-fill', '0');
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => fill.style.setProperty('--or-fill', value)),
    );
  } else {
    fill.style.setProperty('--or-fill', value);
  }
}

const track = (ratio: number | null, tone: 'primary' | 'muted' = 'primary'): HTMLElement => {
  const fill = h('div', { class: ['or-dec-fill', tone === 'muted' && 'is-muted'] });
  if (ratio !== null) grow(fill, ratio);
  return h('div', { class: 'or-dec-track', 'aria-hidden': 'true' }, fill);
};

const percentText = (p: number | null): string => (p === null ? '' : formatPercent(p));

function noulBody(result: Extract<QuestionResult, { kind: 'noul' }>): HTMLElement[] {
  return [
    h(
      'div',
      { class: 'd-flex flex-wrap justify-content-between align-items-baseline gap-2' },
      h(
        'span',
        { class: 'fs-5 fw-semibold', 'data-testid': 'dec-yes-text' },
        `Yes ${formatPercent(result.yes)}`,
      ),
      h(
        'span',
        { class: 'text-body-secondary', 'data-testid': 'dec-no-text' },
        `No ${formatPercent(1 - result.yes)}`,
      ),
    ),
    track(result.yes),
  ];
}

function choiceBody(result: Extract<QuestionResult, { kind: 'choice' }>): HTMLElement[] {
  const row = (bar: OptionBar): HTMLElement =>
    h(
      'li',
      {
        class: 'vstack gap-1',
        'data-testid': 'dec-option-result',
        dataset: { chosen: String(bar.chosen), option: bar.name },
      },
      h(
        'div',
        { class: 'd-flex justify-content-between align-items-baseline gap-2' },
        h(
          'span',
          { class: ['text-break', bar.chosen && 'fw-semibold'] },
          bar.name,
          bar.chosen
            ? h(
                'span',
                { class: 'badge text-bg-primary ms-2 align-text-bottom' },
                icon('check-lg', 'me-1'),
                'Chosen',
              )
            : null,
        ),
        h(
          'span',
          { class: 'text-nowrap', 'data-testid': 'dec-option-percent' },
          percentText(bar.probability),
        ),
      ),
      bar.probability === null ? null : track(bar.probability, bar.chosen ? 'primary' : 'muted'),
    );
  return [
    h(
      'ul',
      { class: 'list-unstyled vstack gap-2 mb-0', 'aria-label': 'Probability of each option' },
      result.bars.map(row),
    ),
  ];
}

function scoreBody(result: Extract<QuestionResult, { kind: 'score' }>): HTMLElement[] {
  const { levels } = result;
  const last = Math.max(1, levels.length - 1);
  const lowest = levels[0]?.text ?? '';
  const highest = levels[levels.length - 1]?.text ?? '';
  const nearest = levels[result.nearest];
  const at = (index: number): string => `${(index / last) * 100}%`;
  const scale = h(
    'div',
    {
      class: 'or-dec-scale',
      role: 'img',
      'aria-label': `Score ${formatScore(result.score)} on a scale from 0 (${lowest}) to ${levels.length - 1} (${highest})`,
    },
    h('div', { class: 'or-dec-scale-line' }),
    levels.map((level) =>
      h(
        'div',
        { class: 'or-dec-tick', style: { left: at(level.index) }, title: level.text },
        h('span', { class: 'or-dec-tick-label' }, String(level.index)),
      ),
    ),
    h(
      'div',
      { class: 'or-dec-marker', style: { left: `${(result.position / last) * 100}%` } },
      h('span', { class: 'or-dec-marker-value' }, formatScore(result.score)),
      icon('caret-down-fill'),
    ),
  );
  const row = (level: LevelBar): HTMLElement =>
    h(
      'li',
      {
        class: 'd-flex align-items-baseline gap-2',
        'data-testid': 'dec-level-result',
        dataset: { level: String(level.index) },
      },
      h('span', { class: 'or-dec-level-index', 'aria-hidden': 'true' }, String(level.index)),
      h(
        'span',
        { class: ['flex-grow-1 text-break', level.index === result.nearest && 'fw-semibold'] },
        h('span', { class: 'visually-hidden' }, `Level ${level.index}: `),
        level.text,
      ),
      h(
        'span',
        { class: 'text-nowrap', 'data-testid': 'dec-level-percent' },
        percentText(level.probability),
      ),
    );
  return [
    h(
      'div',
      null,
      h(
        'span',
        { class: 'fs-5 fw-semibold', 'data-testid': 'dec-score-text' },
        `Score ${formatScore(result.score)}`,
      ),
      h(
        'span',
        { class: 'text-body-secondary ms-2' },
        `closest to level ${result.nearest}${nearest?.text ? `: ${nearest.text}` : ''}`,
      ),
    ),
    scale,
    h(
      'ul',
      { class: 'list-unstyled vstack gap-1 mb-0', 'aria-label': 'Probability of each level' },
      levels.map(row),
    ),
  ];
}

interface Card {
  id: string;
  result: QuestionResult;
  badge: HTMLElement;
  threshold: HTMLElement;
  element: HTMLElement;
  /** The threshold the card is labelled with now. */
  shown: number;
}

export function resultsView(): ResultsView {
  let cards: Card[] = [];
  const summary = h('div', { class: 'fw-semibold me-auto', 'data-testid': 'dec-summary' });
  const actions = h('div', { class: 'd-flex flex-wrap gap-2' });
  const meta = h('div', {
    class: 'small text-body-secondary text-break',
    'data-testid': 'dec-meta',
  });
  const list = h('ol', {
    class: 'list-unstyled vstack gap-3 mb-0',
    'aria-label': 'Answers',
    'data-testid': 'dec-results',
  });
  const empty = emptyState({
    icon: 'signpost-split',
    title: 'No answers yet',
    text: 'Describe the situation, set up your questions and press Decide. One card per question appears here.',
    compact: true,
    testId: 'dec-empty',
  });
  const filled = h(
    'div',
    { class: 'vstack gap-3', hidden: true },
    h('div', { class: 'd-flex flex-wrap align-items-center gap-2' }, summary, actions),
    meta,
    list,
  );
  const element = h('div', { class: 'vstack gap-3' }, empty, filled);

  const verdictClass = (verdict: Verdict): string =>
    verdict === 'clear' ? 'badge text-bg-success' : 'badge text-bg-warning';

  const label = (card: Card, threshold: number): void => {
    const verdict = resultVerdict(card.result, threshold);
    card.shown = threshold;
    card.badge.className = verdictClass(verdict);
    card.badge.replaceChildren(
      icon(verdict === 'clear' ? 'check-circle' : 'exclamation-triangle', 'me-1'),
      VERDICT_TEXT[verdict],
    );
    card.element.dataset['verdict'] = verdict;
    card.threshold.textContent = `Threshold ${threshold}%`;
  };

  const summarise = (): void => {
    const review = cards.filter(
      (card) => resultVerdict(card.result, card.shown) === 'review',
    ).length;
    summary.textContent = `${plural(cards.length, 'question')} answered · ${
      review === 0 ? 'all clear' : `${review} ${review === 1 ? 'needs' : 'need'} review`
    }`;
  };

  const confidenceLine = (result: QuestionResult): HTMLElement | null => {
    if (result.kind === 'none') return null;
    const basis = result.basis ? BASIS_TEXT[result.basis] : '';
    return h(
      'span',
      { 'data-testid': 'dec-confidence' },
      result.confidence === null
        ? 'Confidence not reported'
        : `Confidence ${formatPercent(result.confidence)}${basis ? ` (${basis})` : ''}`,
    );
  };

  const cardFor = (result: QuestionResult, def: QuestionDef): Card => {
    const badge = h('span');
    const threshold = h('span', { 'data-testid': 'dec-threshold-text' });
    const body =
      result.kind === 'noul'
        ? noulBody(result)
        : result.kind === 'choice'
          ? choiceBody(result)
          : result.kind === 'score'
            ? scoreBody(result)
            : [
                h(
                  'p',
                  { class: 'mb-0 text-body-secondary', 'data-testid': 'dec-none' },
                  result.reason,
                ),
              ];
    const element = h(
      'li',
      {
        class: 'or-dec-result border rounded p-3 vstack gap-2',
        'data-testid': 'dec-result',
        dataset: { question: result.id, kind: result.kind },
      },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        h('h3', { class: 'h6 mb-0 text-break' }, result.name.trim() || result.id),
        h('code', { class: 'small text-body-secondary' }, result.id),
        h('span', { class: 'badge border text-body-secondary fw-normal' }, TYPE_LABELS[def.type]),
        h('span', { class: 'ms-auto', 'data-testid': 'dec-verdict' }, badge),
      ),
      body,
      h(
        'div',
        { class: 'd-flex flex-wrap column-gap-3 small text-body-secondary' },
        confidenceLine(result),
        threshold,
      ),
    );
    const card: Card = { id: result.id, result, badge, threshold, element, shown: def.threshold };
    label(card, def.threshold);
    return card;
  };

  return {
    element,
    actions,
    show(result: DecisionResult, questions: readonly QuestionDef[]) {
      cards = result.results.flatMap((entry, index) => {
        const def = questions[index];
        return def ? [cardFor(entry, def)] : [];
      });
      list.replaceChildren(...cards.map((card) => card.element));
      summarise();
      const cost =
        result.costUsd === null
          ? 'Cost not reported'
          : result.costUsd === 0
            ? 'Cost: free'
            : `Cost ${formatUsd(result.costUsd)}`;
      replace(
        meta,
        result.model ? h('span', null, 'Answered by ', h('code', null, result.model)) : null,
        result.model ? ' · ' : null,
        h('span', { 'data-testid': 'dec-cost' }, cost),
      );
      empty.hidden = true;
      filled.hidden = false;
      list.removeAttribute('aria-busy');
      element.classList.remove('opacity-50');
    },
    relabel(thresholds) {
      for (const card of cards) {
        const next = thresholds.get(card.id);
        if (next !== undefined && next !== card.shown) label(card, next);
      }
      summarise();
    },
    busy(on) {
      element.classList.toggle('opacity-50', on);
      if (on) list.setAttribute('aria-busy', 'true');
      else list.removeAttribute('aria-busy');
    },
    hasResults: () => cards.length > 0,
  };
}
