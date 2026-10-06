/**
 * Decision: describe a situation (a text block or key-value fields), set up any number of yes/no, choice and
 * score questions, and get a typed answer with probabilities for each from a decisions model (Jev, or Mercury
 * Decide for free). One run per press, one request for all the questions, billed by input tokens only.
 *
 * The form is the situation panel (state-panel.ts), the question builder (builder.ts) and the library of
 * templates and saved deciders (library.ts); the answers are drawn by results-view.ts and read by results.ts.
 * Everything that decides what is sent or shown lives in the DOM-free schema.ts and results.ts.
 */
import type { DecisionRequest, DecisionResponse } from '../../core/api/types';
import { readAsText } from '../../core/files';
import { toJsonBlob } from '../../core/export/table';
import { debounce } from '../../core/util';
import { exportMenu } from '../../ui/components/export-menu';
import { h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { isStop, presentError } from '../../ui/feedback/errors';
import { copyWithToast } from '../../ui/clipboard';
import { formatBytes, formatInt, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { ToolContext, ToolInstance, ToolSnapshot } from '../../ui/tool/index';
import { questionBuilder } from './builder';
import { libraryBar } from './library';
import { exportDocument, parseDecision, resultVerdict, reviewCount } from './results';
import { resultsView } from './results-view';
import {
  blankQuestion,
  buildRequest,
  hasSituation,
  promptOf,
  readFieldRows,
  readQuestions,
  readState,
  runTitle,
  thresholdOf,
} from './schema';
import { statePanel } from './state-panel';
import { TEMPLATES, templateQuestions } from './templates';
import {
  contextInputTokens,
  contextProblem,
  DEFAULT_CONTEXT_TOKENS,
  estimateInputTokens,
} from './tokens';

/** A dropped text file longer than this is not read: the model's context could not hold it anyway. */
const MAX_TEXT_BYTES = 1024 * 1024;

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  const refresh = debounce(() => void ui.refreshEstimate(), 250);
  const defaultThreshold = (): number => thresholdOf(ctx.options.get()['threshold']);

  // --- the answers --------------------------------------------------------------------------------------
  const results = resultsView();
  /** The last run's request and response, for Download and Copy. */
  let last: { request: DecisionRequest; response: DecisionResponse } | null = null;
  const exported = (): Record<string, unknown> | null =>
    last ? exportDocument(last.request, last.response) : null;

  const menu = exportMenu({
    formats: [
      {
        label: 'JSON',
        extension: 'json',
        icon: 'braces',
        build: () => toJsonBlob(exported() ?? {}),
      },
    ],
    filename: 'decision',
    disabled: true,
    testId: 'dec-export',
  });
  const copyButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
      disabled: true,
      'data-testid': 'dec-copy',
      onclick: () => {
        const doc = exported();
        if (doc) void copyWithToast(JSON.stringify(doc, null, 2), 'Copied the decision as JSON.');
      },
    },
    icon('clipboard'),
    'Copy JSON',
  );
  results.actions.append(menu, copyButton);
  ui.output.append(results.element);

  // --- the form -----------------------------------------------------------------------------------------
  const panel = statePanel({ onChange: refresh });
  /** The questions as last loaded, saved or restored; a different set is "edited". */
  let baseline = '';
  const snapshot = (): string => JSON.stringify(builder.questions());
  const markBaseline = (): void => {
    baseline = snapshot();
  };

  const builder = questionBuilder({
    onChange: () => {
      results.relabel(builder.thresholds());
      refresh();
    },
    defaultThreshold,
  });
  builder.setQuestions([blankQuestion(defaultThreshold())]);
  markBaseline();

  const library = libraryBar({
    store: ctx.state,
    bus: ctx.bus,
    tool: ctx.manifest.id,
    defaultThreshold,
    questions: () => builder.questions(),
    state: () => panel.state(),
    hasState: () => hasSituation(panel.state()),
    dirty: () => snapshot() !== baseline,
    load: (entry) => {
      builder.setQuestions(entry.questions);
      if (entry.state) panel.setState(entry.state);
      markBaseline();
      results.relabel(builder.thresholds());
      refresh();
    },
    saved: markBaseline,
  });
  void library.reload();

  const tokenNote = h('div', { class: 'small text-body-secondary', 'data-testid': 'dec-tokens' });
  const contextAlert = h(
    'div',
    {
      class: 'alert alert-danger py-2 small mb-0',
      role: 'alert',
      hidden: true,
      'data-testid': 'dec-context-alert',
    },
    'Too long for this model. Shorten the situation, remove questions, or choose a model with a larger context.',
  );
  const showTokens = (tokens: number, limit: number): void => {
    tokenNote.textContent = `Input: about ${formatInt(tokens)} of ${formatInt(limit)} tokens`;
    contextAlert.hidden = tokens <= limit;
  };

  const questionsTitle = uid('dec-questions-title');
  ui.input.append(
    panel.element,
    h(
      'section',
      {
        class: 'vstack gap-3',
        'aria-labelledby': questionsTitle,
        'data-testid': 'dec-questions-section',
      },
      h('h3', { id: questionsTitle, class: 'h6 mb-0' }, 'Questions'),
      library.element,
      builder.element,
      tokenNote,
      contextAlert,
    ),
  );

  // --- the drawer ---------------------------------------------------------------------------------------
  const thresholdId = uid('dec-default-threshold');
  const thresholdHelp = uid('dec-default-threshold-help');
  const defaultInput = h('input', {
    id: thresholdId,
    type: 'number',
    class: 'form-control',
    min: '0',
    max: '100',
    step: '1',
    'aria-describedby': thresholdHelp,
    'data-testid': 'dec-default-threshold',
    value: String(defaultThreshold()),
    onchange: () => {
      const value = thresholdOf(
        defaultInput.value.trim() === '' ? NaN : Number(defaultInput.value),
      );
      defaultInput.value = String(value);
      ctx.options.set({ threshold: value });
    },
  });
  ui.drawer.append(
    h(
      'div',
      null,
      h('label', { class: 'form-label fw-semibold', htmlFor: thresholdId }, 'Starting threshold'),
      h(
        'div',
        { class: 'input-group' },
        defaultInput,
        h('span', { class: 'input-group-text' }, '%'),
      ),
      h(
        'div',
        { class: 'form-text', id: thresholdHelp },
        'The confidence a new question needs to be called clear. Questions you already have keep their own.',
      ),
    ),
    h(
      'div',
      { class: 'small text-body-secondary' },
      h('p', { class: 'fw-semibold mb-1' }, 'Model'),
      h(
        'p',
        { class: 'mb-0' },
        'Choose it with the model button above the form. Jev and Mercury Decide are the only models verified to accept these questions; other decision models may refuse them or answer in another shape.',
      ),
    ),
  );

  // --- running ------------------------------------------------------------------------------------------
  const run = async (signal: AbortSignal): Promise<void> => {
    // Nothing is sent, booked or changed until everything checks out (a refused run leaves the page as it was).
    if (!panel.validate()) {
      ui.status('Describe the situation first.');
      return;
    }
    if (!builder.validate()) {
      ui.status('Fix the questions first.');
      return;
    }
    const questions = builder.questions();
    const keys = builder.keys();
    const state = panel.state();
    const model = ctx.model().model;
    if (!model) return;
    const info = await ctx.models.get(model).catch(() => undefined);
    const limit = info?.contextLength ?? DEFAULT_CONTEXT_TOKENS;
    const tokens = contextInputTokens(buildRequest(model, state, questions));
    showTokens(tokens, limit);
    const tooLong = contextProblem(tokens, limit);
    if (tooLong) {
      ui.status('Too long for this model.');
      announce(tooLong, { assertive: true });
      return;
    }

    const handle = await ctx.beginRun({ title: runTitle(questions) }, signal);
    results.busy(true);
    ui.status('Deciding…');
    let decision: ReturnType<typeof parseDecision>;
    let response: DecisionResponse;
    try {
      const request = buildRequest(handle.model, state, questions);
      response = await ctx.api.decide(request, { run: handle });
      decision = parseDecision(response, questions);
      last = { request, response };
      results.show(decision, questions, keys);
      // A threshold edited while the request was out applies to the cards drawn now.
      const current = builder.thresholds();
      results.relabel(current);
      menu.update({ disabled: false });
      copyButton.disabled = false;
      const review = decision.results.filter(
        (entry, index) =>
          resultVerdict(
            entry,
            current.get(keys[index] ?? '') ?? questions[index]?.threshold ?? 0,
          ) === 'review',
      ).length;
      ui.status(`Done · ${plural(questions.length, 'question')}, ${reviewCount(review)}`);
    } catch (error) {
      results.busy(false);
      ui.status(isStop(error) ? 'Stopped' : 'Failed');
      await handle.fail(error);
      throw error;
    }
    // The answer is in and paid for: a failure to record it is shown, but never turns it into a failed run with a
    // Retry (which would pay again).
    await handle
      .finish({
        output: JSON.stringify(response.answers),
        meta: {
          questions: questions.length,
          answeredBy: decision.model,
          costUsd: decision.costUsd,
        },
      })
      .catch((error: unknown) => void presentError(error));
  };

  ui.runner({ label: 'Decide', icon: 'signpost-split', run });

  // --- the instance -------------------------------------------------------------------------------------
  const getState = (): ToolSnapshot => {
    const state = panel.state();
    return {
      // What is sent: the text block, or the `name: value` lines of the fields.
      prompt: promptOf(state),
      settings: {
        stateMode: state.mode,
        fields: state.fields,
        // The text block kept behind the fields is never sent, so it is not the prompt; it travels here.
        ...(state.mode === 'fields' ? { text: state.text } : {}),
        questions: builder.questions(),
      },
    };
  };

  /** Adds the texts to the situation (or replaces it) and switches to the text block; false when they hold nothing. */
  const addText = (parts: readonly string[], replaceText: boolean): boolean => {
    const added = parts.filter((part) => part.trim() !== '');
    if (added.length === 0) return false;
    const current = panel.state();
    const text = [replaceText ? '' : current.text.trim(), ...added].filter(Boolean).join('\n\n');
    panel.setState({ ...current, mode: 'text', text });
    refresh();
    return true;
  };

  return {
    getState,
    applyState({ prompt, settings }) {
      const questions = readQuestions(settings['questions']);
      const mode = settings['stateMode'] === 'fields' ? 'fields' : 'text';
      panel.setState(
        readState({
          mode,
          // In fields mode the prompt only describes the fields; the text block behind them is in the settings.
          text: mode === 'fields' ? settings['text'] : prompt,
          fields: readFieldRows(settings['fields']) ?? panel.state().fields,
        }),
      );
      if (questions) {
        builder.setQuestions(questions);
        markBaseline();
      }
      results.relabel(builder.thresholds());
      void ui.refreshEstimate();
    },
    async estimate(model) {
      const request = buildRequest(model, panel.state(), builder.questions());
      const info = await ctx.models.get(model).catch(() => undefined);
      showTokens(contextInputTokens(request), info?.contextLength ?? DEFAULT_CONTEXT_TOKENS);
      // The price is estimated high (JSON counts more than prose); the context check above is not.
      return ctx.models.estimate({
        kind: 'decision',
        model,
        inputTokens: estimateInputTokens(request),
      });
    },
    onFiles(files) {
      const readable = files.filter((file) => file.size <= MAX_TEXT_BYTES);
      if (readable.length < files.length) {
        ui.status(
          `${plural(files.length - readable.length, 'file')} skipped: over ${formatBytes(MAX_TEXT_BYTES)}.`,
        );
      }
      if (readable.length === 0) return;
      Promise.all(readable.map((file) => readAsText(file)))
        .then((parts) => {
          if (!addText(parts, false)) ui.status('The files had nothing to add.');
        })
        .catch((error: unknown) => void presentError(error));
    },
    onReceive(items) {
      const texts = items.flatMap((item) => (item.kind === 'text' ? [item.text] : []));
      if (!addText(texts, true)) ui.status('What was sent had nothing to add.');
    },
    sample() {
      const template = TEMPLATES[0]!;
      builder.setQuestions(templateQuestions(template.id, defaultThreshold()) ?? []);
      markBaseline();
      panel.setState({ ...panel.state(), mode: 'text', text: template.sample });
      results.relabel(builder.thresholds());
      refresh();
    },
  };
}
