# Building a tool

How to build one of the 14 tools on the Stage 2 shell. Read [CLAUDE.md](../CLAUDE.md) first (architecture rules and conventions are binding) and [openrouter-api.md](openrouter-api.md) for the endpoint you call. Every tool page renders through `mountTool` with its own setup.

## The contract in one screen

```text
src/tools/<id>/manifest.json   static half: name, icon, category, capabilities (first = primary), accepts, produces, lazyLibs, defaults, ownModels?
src/tools/<id>/main.ts         mountTool(getTool('<id>'), setup)          ← the only line that must stay
src/tools/<id>/*.ts            your pipeline, UI pieces and *.test.ts (never import another tool's folder)
```

```ts
mountTool(manifest: ToolManifest, setup: ToolSetup, options?: { isolation?: 'required' }): void
type ToolSetup = (ctx: ToolContext) => ToolInstance | Promise<ToolInstance>;

interface ToolInstance {
  getState(): ToolSnapshot;                     // { prompt: string; settings: Record<string, unknown> }
  applyState(state: ToolSnapshot): void;         // must reproduce exactly what getState() returned
  estimate?(model: string): Promise<number | null>; // cost of the current input on `model` (see Cost estimates)
  addons?(): readonly RunAddon[];                // paid extras besides the model, e.g. a PDF parser (see Paid add-ons)
  onFiles?(files: File[]): void;                 // page-wide drop and paste, filtered by manifest.accepts
  onReceive?(items: SendItem[]): void;           // "Send to…" from another tool, filtered by manifest.accepts
  sample?(): void | Promise<void>;               // ?sample=1 and onboarding's "Try a sample"
}
```

All types live in `src/ui/tool/types.ts` and are re-exported from `src/ui/tool/index.ts`.

`mountTool` installs the page-wide drop/paste guard first (so a file dropped while the page is still loading never makes the browser open it and leave), renders the page shell (navbar, palette, toasts, leave guard, budget confirmation), the tool header (icon, name, description, model chip, key chip when there are several keys, cost estimate, Prompts, Settings, History) and three empty zones, builds the context, awaits `setup`, then:

1. creates the Prompts panel around your `getState`/`applyState`;
2. calls `ctx.jobs.resume()` (register job handlers **inside** `setup`);
3. routes dropped and pasted files to `onFiles` (only accepted ones; see Files in and out);
4. computes the first estimate (`estimate`, if you provide it);
5. applies the URL: `?run=<id>` (History → `applyState`), `?prompt=<id>` (a saved or recent prompt), `?sample=1` (`sample()`), `?receive=<id>` (Send to… hand-over → `onReceive`); these are removed from the address bar afterwards. `?model=<id>` stays and overrides the primary model for this visit ("re-run with another model").

Video studio passes `{ isolation: 'required' }` (multi-threaded ffmpeg). No other tool does.

**Tools that choose their own models** (Model arena's contenders, Bot-to-bot's two bots) set `"ownModels": true` in the manifest. One flag, read by both places that would otherwise name a single model:

- the tool header shows no model chip and no free-only substitution note (the note would name a model the tool does not use). The key chip and the estimate stay, `?model=` still arrives as `ctx.modelOverride` (the tool decides what it means), and Run is still disabled, with the free-only notice, when free-only mode leaves the primary capability no model at all;
- Settings → Tools shows "Chosen inside the tool" instead of a model picker. The primary capability's model (a binding saved earlier, else Settings → Models' default) is only where a new setup starts: the arena's first contenders, a bot that has no model of its own. Reset still clears an old binding.

## The context

`ToolContext` is every core service (`ctx.api`, `ctx.runs`, `ctx.models`, `ctx.history`, `ctx.prompts`, `ctx.jobs`, `ctx.results`, `ctx.settings`, `ctx.keys`, …; see `src/core/types.ts`) plus the members below. Use `ctx` everywhere; a tool never calls `getCore()`.

| Member | What it is |
| --- | --- |
| `manifest` | Your manifest. |
| `state` | `ToolStateStore` for this tool (IndexedDB `kv`): JSON-safe, persistent, e.g. saved deciders or a video sequence. Never binaries. Every `set` and `delete` emits `{ type: 'tool-state-changed', tool, key }` on `ctx.bus`, in this tab and the others, and so do Reset everything, Delete all prompts and history and a backup import for every key they remove or write: a page showing stored values stays in step with `ctx.bus.on('tool-state-changed', (e) => e.tool === ctx.manifest.id && reread(e.key))` (your own writes arrive too). See Stored state below for `update` and resets. |
| `options` | `{ get(), set(patch), reset() }`: `manifest.defaults` merged with the user's saved options (`settings.tools[id].options`). `set` stores only what you pass. |
| `ui` | The zones and helpers below. |
| `model(cap?)` | `ResolvedModel` for a capability (default: the primary one, `capabilities[0]`), with free-only applied. `model === null` means nothing may run; for the primary capability the framework already shows the notice and disables Run. See Models per capability. |
| `modelOverride` | `?model=` or null. |
| `beginRun(spec, signal?)` | `runs.begin` for this tool: fills `tool`, `model` (default `ctx.model().model`), `prompt` and `settings` (from your `getState()`), `estimateUsd` (default: the header's current estimate, recomputed first if the input changed since; for a `model` other than the header's, your `estimate(model)` hook for that model, so the per-run limit still applies), `addons` (default: your `addons()`), and aborts the run when `signal` aborts. Call it **before** changing any tool state (see Refused runs change nothing). |

### Models per capability

`ctx.model()` (the primary capability) runs the cascade `?model=` → the header's choice (the tool binding, `settings.tools[id].model`) → the capability default (Settings → Models) → the shipped default. **Every other capability skips the first two**: `ctx.model('vision')` on Chat starts at the vision default, because a text model pinned in the header may not read images. To let users choose a secondary model, give it its own control (`modelPicker(ctx, { capability: 'vision' })`) and keep the choice in `ctx.options`.

`ctx.ui`:

| Member | What it does |
| --- | --- |
| `input`, `output` | The two zone bodies (`.card-body`). Input is left on wide screens, output right; they stack on narrow ones. |
| `drawer` | Body of the Settings offcanvas. Put everyday options here. |
| `advanced(title)` | Adds a collapsed accordion section at the end of the drawer and returns its body. |
| `runner<A>({ label, icon, run(signal, arg?), hint, container, hideWhileBusy })` | The Run/Stop bar, appended to `input` (or `container`). The first runner gets Ctrl/Cmd+Enter (Run, no argument). Returns `Runner<A>`: `trigger(arg?)` (see Runner arguments), `stop()`, `setDisabled(reason)`, `setLabel(text)`, `addAction(options)` (see A Run bar with more than Run), `busy`, `disabledReason`, `subscribe(fn)`. |
| `refreshEstimate()` | Recomputes the estimate through `ToolInstance.estimate` and shows it; resolves with the value. Call it when the input changes. |
| `setEstimate(usd \| null, note?)` | Sets the badge directly (`≈ $0.0012`, `Free` for 0, `Unknown` for null), for tools without `estimate`. |
| `status(text)` | A state change in the output header ("Reading 3 pages…", "Done"), announced politely. |
| `progress(text)` | A ticking counter in the same line ("Composing… 12 s", "18 of 75 parts", "40%"): shown at once, announced at most once every 10 s. Use `status` for the start and end of a phase, `progress` for everything in between. |
| `holdWork(description)` | Marks unsaved in-memory work that is not a downloadable result (a recording in progress, paid parts not joined yet): leaving asks first (in-app dialog and the browser's prompt), naming `description`. Returns the release; call it when the work is saved or discarded. |
| `addResult({ kind, name, blob })` | Registers an in-memory binary result (leave guard) and returns `{ result, button(label?), download(), remove() }`. |
| `sendTo(items)` | Opens the "Send to…" chooser for these items. |
| `openPrompts()`, `openDrawer()` | What the header buttons do. |

`ctx.ui` members are plain function properties, so `sendTo: ctx.ui.sendTo` works.

## Running something

Every model call belongs to a run (rule 2). The pattern, inside the runner's `run(signal)`:

```ts
const run = await ctx.beginRun({ title: 'Optional history title' }, signal); // estimate from your `estimate` hook
try {
  const result = await ctx.api.chat({ model: run.model, messages }, { run });   // pass { run } to every call
  await run.finish({ output: result.choices[0]?.message.content ?? '' });     // text only, never binaries
} catch (error) {
  output.fail(error);      // if you have an output panel (below)
  await run.fail(error);   // AbortError → 'aborted', anything else → 'error'
  throw error;             // the runner reports it, once
}
```

**One error rule.** Whatever the tool catches, it rethrows, and the runner decides what the user sees:

- **Stop** (an `AbortError`, or Cancel in the budget confirmation, `RunCancelledError`) is not an error: nothing is shown but a neutral "Stopped" status; partial output stays.
- An error the output panel already showed inline (`output.fail(error)` marks it) is not shown again.
- Errors that need an action (no key → Connect / paste a key, locked → unlock, free-only, budget blocked, storage full) always go to `presentError`, which opens the right dialog and retries.
- Anything else is shown once: inline by the output panel, or by `presentError` (a toast with Retry) when there is no panel.
- **Unknown outcome:** a paid request that may have gone through (`isOutcomeUnknown(error)`: connection lost after sending, 408, or a 5xx other than 503) never gets a plain Retry. Give the runner a `safeAction` (e.g. `{ label: 'Check status', onClick }`); without one the toast links to OpenRouter's activity page. Set `retryUnknownOutcome` only when sending again cannot pay twice.

Outside the runner (reading a dropped file, an export, a button of your own), catch and call `presentError(error)` yourself; never show the same error twice and never `console.error` it away.

**Showing an error inline** (on a reply, a panel, a row) is `failureText(error, { blind? })` from `src/ui/feedback/errors.ts`, never bare `userMessage(error)`, which drops the caution an unknown outcome needs. It returns `{ text, outcomeUnknown, activityUrl, note }`: show `text`; when `outcomeUnknown`, offer no plain Retry (a resend could pay twice) and link `activityUrl` (`externalLink(OPENROUTER_ACTIVITY_URL, 'OpenRouter activity')`); keep the flag with the message if the message is stored. Then `markPresented(error)`, so the runner stays quiet: the inline text is the presentation. Errors that `needsAction(error)` still go to `presentError`.

`blind: true` is for Model arena while names are hidden, where anything that differs between a free and a paid model gives it away: a 402's "not enough credits", the 429 text about free models, provider and model names in OpenRouter's messages, a caution that shows only after an unknown outcome, a Retry that goes missing. So every failure reads alike: a generic `text` that is true for any model, `note` (`BLIND_ACTIVITY_NOTE`, "Before retrying, you can check your OpenRouter activity to see whether this request was billed.") for every failed panel, `activityUrl` always set, `outcomeUnknown` always false. Keep the real wording for the reveal: store `failureText(error)` as well and show it once names are shown.

`beginRun` (via `runs.begin`) refuses before anything is sent: no key (`no-key`), locked keys (`locked`), free-only with a paid model (`free-only`), a hard budget (`budget-blocked`). In Warn mode, or above the per-run threshold, the shell's **budget confirmation** opens by itself; Cancel throws `RunCancelledError`. You never handle any of this yourself: throw, and the rule above applies. Runs that belong together (arena contenders, the steps of a sequence) ask ONE question for the group instead: see Groups of runs.

Long runs: `run.checkpoint({ output })` persists partial text (bot transcripts, batches), throttled to one write per interval. Pass `output` as a function (`run.checkpoint({ output: () => combined() })`) when building the text is costly: it is called only when a write actually happens (and once more by `finish()` without an output). Parallel runs of one action share a `groupId` (arena contenders). A run that calls several models lists them in `models` so free-only checks them all.

A run stopped before it sent anything (Stop during the free-model wait, a step paused before its request) books nothing: History keeps it as stopped, Stats count no run. A run that failed with an error still counts as one error run.

### Groups of runs: one budget question

Several runs that the user starts with one action are checked and confirmed once, for their **total**: the key and the lock once, free-only across all their models and paid add-ons, the budgets against the total estimate (add-ons included), and one dialog that names the group (your label, its models, the total, an optional note). Each run still reserves its own estimate when it begins, and a hard (monthly) block still refuses it.

**Runs that start together** (Model arena's contenders): `ctx.runs.beginAll(specs, { label, signal })` approves them as one group and begins them all, or none. When one is refused (Cancel, a block, the signal), the ones already begun are withdrawn: no record, no reservation, nothing sent or booked, and the refusal is thrown as `beginRun` would. Fill each spec as `ctx.beginRun` would (`tool`, `model`, `estimateUsd`, `addons`, `prompt` and `settings` from `getState()`); they share `specs[0].groupId`, and the handles come back in the order of `specs`. A member whose estimate is unknown is left out of the total and counted (the dialog says "≈ $0.27 + 1 unknown"; budgets treat the total as a floor).

```ts
const snapshot = getState();
const runs = await ctx.runs.beginAll(
  planned.map((p) => ({
    tool: ctx.manifest.id,
    model: p.model,
    estimateUsd: p.estimate,
    addons: p.addons,
    prompt: snapshot.prompt,
    settings: snapshot.settings,
    groupId: roundId,
  })),
  { label: `Model arena round: ${plural(planned.length, 'model')}`, signal },
);
// Only now change the page (Refused runs change nothing); then stream into each run.
```

**Runs that start over time** (a video sequence's steps, possibly after a reload or in another tab): approve once at Start, then begin each step with `useGroupApproval`:

```ts
await ctx.runs.approveGroup({            // throws like beginRun; RunCancelledError when declined
  tool: ctx.manifest.id,
  groupId: sequence.id,
  label: `Video sequence: ${plural(steps, 'clip')}`,
  models: [model],
  runs: steps,                            // how many runs it covers
  estimateUsd: total,                     // the whole group's estimate (null = unknown)
  note: 'Spend cap $2.00: it stops before a step would pass it.',
});
// …later, for each step (no dialog while the approval has room for it):
await ctx.beginRun({ estimateUsd: step, groupId: sequence.id, useGroupApproval: true }, signal);
// A re-run outside the plan leaves useGroupApproval out: it asks for itself.
await ctx.runs.releaseGroup(sequence.id); // when the group is done with (New sequence)
```

The approval is stored (IndexedDB `kv`), so it holds in every tab and after a reload until `releaseGroup`, a new approval of the same group id or a data reset. It covers at most `runs` runs, together within the approved total when that is known, on the approved key and models; a run beyond that asks for itself. A run that ends having sent nothing gives its share back. Groups on free models only need no approval and store none. When some runs' estimates are unknown, pass the sum of the known ones as `estimateUsd` and how many are unknown as `unknownEstimates`.

A run's reservation is on its handle, `run.reservedUsd` (its estimate plus add-ons). When its cost turns out unknown, budgets and Stats book `max(cost, reservedUsd)`: show it as `formatRunCost(cost, { booked: Math.max(totals.costUsd, run.reservedUsd) })`, which reads "Unknown (≈ $x counted)".

### Refused runs change nothing

`beginRun` may refuse (no key, locked, free-only, budget, Cancel in the confirmation) before anything is sent. So read the form and plan first, call `beginRun`, and only then reset results, mark items queued or start the output panel. A refused run then leaves the page exactly as it was (the previous results stay):

```ts
run: async (signal) => {
  const plan = planPages();                       // reads the form; changes nothing
  if (plan.length === 0) return ui.status('Choose at least one page.');
  const run = await ctx.beginRun({ title: batchTitle(plan.map((p) => p.fileName)) }, signal);
  results = plan.map(toQueuedResult);             // only now: the run is on
  output.start();
  // …
},
```

### Runner arguments and per-item Retry

`ui.runner<A>({ run: (signal, arg) => … })` takes an optional argument through `runner.trigger(arg)`, and the error toast's Retry replays the **same** argument. Use it for "retry these items" instead of a variable set before `trigger()`. `trigger()` answers at once whether it started (`.started` is false while busy or disabled; nothing happened then) and settles when the run is over. Keep a tool's own Retry buttons in step with the runner through `subscribe`:

```ts
const runner = ui.runner<string[] | undefined>({ label: 'Read', run: (signal, keys) => read(signal, keys) });
const retry = (keys: string[]) => runner.trigger(keys);           // .started === false: busy or disabled
runner.subscribe(({ busy, disabledReason }) => {
  for (const button of retryButtons()) button.disabled = busy || disabledReason !== null;
});
```

**`retryGate(runner)`** (`src/ui/tool/retry-gate.ts`) is that pattern in one place, and every tool with per-item Retry uses it:

```ts
const runner = ui.runner<string[]>({ label: 'Read', run });
const gate = retryGate(runner);                    // optional: { fallback: () => heading }
const retryButton = (keys: string[]) =>
  gate.bind(h('button', { type: 'button', onclick: () => gate.retry(keys, 'Reading cannot start now.') }, 'Retry'));
```

`bind(button)` keeps the button in step with Run (shown unavailable while Run is busy or disabled, with the reason as its title, but still focusable); `retry(arg, fallbackMessage?)` triggers the runner and announces why when it cannot start; `blocked()` is the current reason or null. When a focused Retry button disappears (its item re-rendered as running) and nothing else took focus, focus goes to `fallback()` (default: Run).

A replay must not pay for finished items again: give the runner `replayArg: pendingOnly((key) => hasResult(key))` (from `src/ui/tool/runner.ts`) and the error toast's Retry sends only the items still without a result (none left: it says so and does nothing).

### A Run bar with more than Run

A tool whose bar is more than one button (Bot-to-bot's Start/Resume, Step and Pause) builds it on the runner, not beside it, so busy, blocked, focus and the sticky bar's height stay the runner's job:

```ts
const runner = ui.runner<'step' | undefined>({
  label: 'Start',
  icon: 'play-fill',
  hideWhileBusy: true, // while a run is going, Pause and Stop take its place
  run: (signal, action) => perform(action, signal),
});
runner.addAction({
  label: 'Step',
  icon: 'skip-end-fill',
  run: 'step',
  title: 'Run exactly one turn, then hold',
});
const pause = runner.addAction({ label: 'Pause', icon: 'pause-fill', when: 'busy', onClick: requestPause });

runner.setLabel('Resume'); // Run's text while idle (Start → Resume)
pause.setLabel('Pausing…');
pause.setDisabled('Pausing after this turn'); // a visible reason in the title; null turns it back on
```

- `runner.addAction(options)` adds a button after Run and before Stop, in call order. `run: arg` makes it start a run like `trigger(arg)`: it is off exactly when Run is, with Run's reason as its title, and the error toast's Retry replays that argument. `onClick` is for anything else. `when: 'idle'` (default) shows it while no run is going, `'busy'` only while one is. `tone: 'primary'` outlines it in the accent colour. It returns `{ button, setLabel, setDisabled(reason) }`.
- An action that is off keeps focus (`aria-disabled`, like Run). When the control that has focus hides (Run → Pause, Stop → Run), focus moves to the first visible control in the bar, for every runner.
- Ctrl/Cmd+Enter always presses the first runner's Run with no argument, so make that the primary action ("Start or Resume"). The bar is one sticky element: its height (`--or-runner-height`) follows whatever it holds, so extra buttons need nothing more.
- **Escape to stop:** `stopOnEscape(runner, { allowIn?: [field] })` (`src/ui/tool/stop-on-escape.ts`) installs the one handler. Escape stops the run that is going, but not with Ctrl/Cmd/Alt, while a dialog, drawer or dropdown is open, while an input method composes, or in a field or select (they use Escape themselves) unless the field is listed in `allowIn` (Chat's composer). It is built on `plainShortcutAllowed` (`src/ui/shell/shortcuts.ts`), as any plain-key shortcut should be, and `composing(event)` lives there too. Do not copy the handler.

### Batches: `runItems`

**Every batch tool (pages, documents, segments, images) works through its items with `runItems()`** (`src/ui/tool/batch.ts`, built on `runPool`) inside one run, so statuses, stopping and error reporting are the same everywhere:

```ts
const run = await ctx.beginRun({ title: batchTitle(names, { retry: keys !== undefined }) }, signal);
try {
  const result = await runItems({
    items: plan,
    concurrency: 3,
    signal: run.signal,
    work: (page, signal) => readPage(run, page, signal),   // return the item's value; throw on failure
    onItem: (outcome) => draw(outcome),                     // queued → running → done | failed | stopped
  });
  await run.finish({ output: combined() });
  ui.status(batchSummary(result, 'page'));                  // "Done · 3 of 4 pages; 1 failed"
} catch (error) {
  await run.fail(error);
  throw error;
}
```

- A failed item does not stop the others; a fatal error (`isFatalError`: no key, locked, invalid key, budget, free-only, storage full, HTTP 401/402) stops scheduling, marks the rest `stopped` and is rethrown for the runner to present.
- Stop: nothing new starts, running items settle, the abort reason is rethrown (silent, as always).
- Every item failed: the last error is rethrown already marked as shown (each item shows its own), so the runner stays quiet but the run is still recorded as failed.
- `batchTitle(names, { retry, noun })` names the run: "Retry: a.pdf and 2 more files".

### Paid add-ons

Some requests cost money besides the model's tokens, even on a free model: OpenRouter's Mistral OCR PDF parser bills per page. Declare such extras with the instance's `addons()` hook (cheap and synchronous); keep them **out** of `estimate`. The framework adds them to the header badge and passes them to `beginRun`, where free-only mode refuses a paid one (`FreeOnlyError` names it), budgets and the reservation include its estimate, and the run no longer counts as free. The PDF engines live in one table, `src/core/models/pdf-engines.ts` (`PDF_ENGINES`, `pdfEngine(id)`, `isPdfEngineId`):

```ts
addons: () => {
  const addon = pdfEngineAddon(engine.value as PdfEngineId, pdfPagesSelected());
  return addon ? [addon] : [];          // null for cloudflare-ai (free) and native (billed as tokens)
},
```

A run can also pass `addons` (`RunSpec.addons: { id, label, estimateUsd }[]`) itself, e.g. a retry that reads only some pages.

### Streaming into the output panel

```ts
const output = outputPanel({ format: 'markdown', filename: 'answer', sendTo: ctx.ui.sendTo });
ctx.ui.output.append(output.element);
// in run():
output.start();                                    // skeleton until the first chunk, "Generating…" announced
await ctx.api.chatStream(body, {
  run,
  onEvent: (event) => {
    if (event.type === 'text') output.append(event.text);   // sanitised Markdown, drawn progressively
  },
});
output.finish();                                   // final render, "Done · 245 words", Copy/Download/Send to… enabled
// on error: output.fail(error) — the error object, not a message (see the error rule)
```

Streaming stays cheap on long answers: blocks that are complete (up to the last blank line outside a code fence) are rendered once; only the unfinished tail is re-rendered, paced by how long rendering takes. The streamed text itself is never a live region (it would read every token); start, finish and Stop are announced.

Tools with their own layout (chat bubbles, bot turns, arena columns) stream with the same renderer, without the panel's chrome: `streamMarkdown(target, { format?, caret?, after?, onRender? })` (`src/ui/components/stream-markdown.ts`) returns `{ append(chunk), set(text), text(), finish(), dispose() }`. Nothing touches `target` before the first chunk or after `dispose()`; `await finish()` resolves when the final render is on screen.

```ts
const stream = streamMarkdown(bubble, { onRender: () => scrollToEnd() });
await ctx.api.chatStream(body, { run, onEvent: (e) => e.type === 'text' && stream.append(e.text) });
await stream.finish();
```

To time a request ("first token", "total"), start the clock in `onSend(attempt)`, which every call takes (`CallOptions`): it fires right before each attempt is actually sent, after the free-model throttle's wait and after a retry's backoff, so neither counts as the model's time.

```ts
let sentAt = 0;
await ctx.api.chatStream(body, { run, onSend: () => (sentAt = performance.now()), onEvent });
```

**A Stop keeps what was paid for.** Both streaming calls reject with the abort, and attach what had arrived: `partialStreamResult(error)` (`src/core/api/chat-stream.ts`) for `chatStream`, `partialImageResult(error)` (`src/core/api/client.ts`) for an `images` stream, which holds the images that completed (and were billed) before the Stop. Show and keep those (as session results) before you end the run as stopped; their cost is already on the run, and the rest of the request is booked as unknown (a provider may finish images after the disconnect).

```ts
} catch (error) {
  const done = partialImageResult(error)?.images ?? [];
  for (const image of done) addResultCard(image); // paid: never drop them
  throw error;                                    // still a Stop
}
```

A stream that sends nothing for 5 minutes fails as a dropped connection (`STREAM_IDLE_MS`; OpenRouter sends keep-alive comments while a model works).

`chatStream` resolves with the assembled `ChatStreamResult`. Its `annotations` (present only when some came) are the streamed `delta.annotations`: for a PDF sent through the `file-parser` plugin, `{ type: 'file', file: { name, content } }` with the parser's text. Keep that text and send it on later turns instead of the PDF (no upload, no parsing, no parser charge), as Chat does.

## Cost estimates

Give the instance an `estimate(model)` hook and call `ctx.ui.refreshEstimate()` whenever the input changes:

```ts
estimate: (model) =>
  ctx.models.estimate({ kind: 'tokens', model, promptTokens: approxTokens(text.value), completionTokens: maxTokens }),
```

Count tokens with `src/core/tokens.ts`, the one approximation every tool uses (never a copy): `approxTokens(text)` (deliberately high and structure-aware: digits and punctuation weigh more than letters, so JSON and code are not under-counted), `MESSAGE_OVERHEAD` per message, `DEFAULT_OUTPUT_TOKENS`, and the context fit for chat-style requests:

```ts
const limits = { context: info.contextLength, maxTokens, maxCompletionTokens: info.maxCompletionTokens, fixed: systemTokens };
const tokens = messages.map((m) => approxTokens(m.text) + MESSAGE_OVERHEAD); // oldest first, one per message
const trimmed = trimOldest(tokens, promptBudget(limits));        // how many of the oldest to leave out (never the last)
const keptTokens = tokens.slice(trimmed).reduce((sum, n) => sum + n, 0);
const fit = fitContext({ ...limits, prompt: keptTokens });       // { budget, tooLong, room, completionTokens, maxTokens }
if (fit.tooLong) throw new InvalidInputError('This is too long for the model’s context window.');
body.max_tokens = fit.maxTokens ?? undefined;                    // null: Max tokens not set, leave it out
// estimate with completionTokens: fit.completionTokens
```

`trimOldest(tokens, budget, startsAt?)` drops the oldest first and always keeps the last message (the one being answered); with `startsAt(index)`, once something went it drops on until the kept part starts where you allow (Chat passes `(i) => turns[i].role === 'user'`, so no reply is left without its question).

The framework asks again when the model changes (header chip, settings, free-only, a catalog refresh), shows only the newest answer (an older, slower one never overwrites it), and `ctx.beginRun` without `estimateUsd` always computes it afresh for the input as it is at that moment (so a paste followed by Ctrl+Enter, before your debounced `refreshEstimate`, books the right amount); only a value set with `ui.setEstimate` is booked as is. A run on another model than the header's (`beginRun({ model })`: "Another model…", an arena contender) books your hook's answer for that model; without a hook it is unknown. Pass `estimateUsd` yourself only when a run costs something else (one step of a sequence). The kinds (`src/core/types.ts`, `EstimateInput`): `tokens`, `speech`, `transcription`, `image`, `video`, `music`, `decision`. Estimates are deliberately high; null means unknown (shown as "Unknown"; the per-run threshold then does not apply). Free models estimate 0.

## Results, downloads and the leave guard

Images, audio, video and files stay in memory (rule 3). Register every one:

```ts
const handle = ctx.ui.addResult({ kind: 'image', name: 'product-1.png', blob });
card.append(imageViewer({ src: ctx.results.objectUrl(handle.result.id), alt: 'Product 1' }).element, handle.button());
```

`handle.button()` downloads and turns into "Downloaded"; it returns the same button on every call (a redraw adds no subscription) and listens until `remove()`. Until a result is downloaded, leaving through a link asks first (listing "3 images and 1 video not downloaded", with Download all), and reloading or closing the tab triggers the browser's own prompt. Call `handle.remove()` when the user discards a result.

For text and table exports use `exportMenu({ filename, formats, resultIds })`, where `resultIds: () => readonly string[]` is read at click time: each format's Blob is built only when chosen (`toCsv`, `toXlsx`, `toDocx`, `zipFiles`, `toSrt`… from `src/core/export`), and the listed results are marked downloaded. Build it once and change it with `menu.update(formats)` or `menu.update({ formats, disabled })`: the menu stays in place, so one the user has open stays open.

## Jobs (long remote work)

Register handlers in `setup`, before it returns (the framework calls `jobs.resume()` right after):

```ts
ctx.jobs.register<VideoPayload, VideoResult>('video', {
  poll: async (job, signal) => {
    const status = await ctx.api.videos.status(job.remoteId!, { keyId: job.keyId, signal });
    if (!status.done) return { state: 'running', progress: null, remoteStatus: status.status };
    if (status.status === 'completed') {
      return { state: 'succeeded', result: { outputs: status.outputs, costUsd: status.costUsd } };
    }
    return { state: 'failed', error: status.error ?? 'The video job did not finish.' };
  },
});

// starting one, inside run():
const run = await ctx.beginRun({}, signal);
try {
  const submitted = await ctx.api.videos.submit(body, { run });
  const job = await ctx.jobs.add<VideoPayload, VideoResult>({
    tool: ctx.manifest.id,
    type: 'video',
    payload,
    keyId: run.keyId,
    remoteId: submitted.id,
    runId: run.id,
  });
  run.handOff(job.id); // from now on unload and Stop do not finalise the run, and leaving the page is safe
} catch (error) {
  await run.fail(error); // the submit (or storing the job) failed: the run ends here
  throw error;
}

// ending it, wherever you observe the outcome (also after a reload, or in another tab):
ctx.jobs.subscribe((record) => {
  const job = record as JobRecord<VideoPayload, VideoResult>;
  if (!job.runId || job.removed) return;
  if (job.state !== 'succeeded' && job.state !== 'failed' && job.state !== 'cancelled') return;
  void ctx.runs.reattach(job.runId).then(async (run) => {
    if (!run) return; // already final
    if (job.state === 'succeeded' && job.result) {
      // Video cost arrives only on the completed status read; the run books it.
      run.addUsage({
        model: run.model,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: job.result.costUsd ?? 0,
        costEstimated: false,
        costUnknown: job.result.costUsd === null,
        latencyMs: job.updatedAt - job.createdAt,
      });
      await run.finish({ meta: { videoJobIds: [job.remoteId] } });
    } else {
      // A handed-off run ignores AbortErrors, so end it with a plain error carrying the reason.
      await run.fail(new Error(job.state === 'cancelled' ? 'The video job was cancelled.' : (job.error ?? 'The video job failed.')));
    }
  });
});
```

**Completion is not download.** Return `usage: { costUsd }` with `succeeded` (metadata and cost only): the core books it on the run before the job turns final, so a download that fails later still counts. Download the content separately, with its own retries; when it cannot happen any more (retention), mark the result expired: the cost is already booked. Read `failureKind` on a failed job: `'remote'` (the provider failed, usually free) or `'gave-up'` (the core stopped asking: poll failures, a 404 after retention, a missing key, or the job was still running 3 hours after it was added, `maxAgeMs` on the handler to change that; it may still be billed, and the reservation is booked). The core records on the run that it booked the job's cost, so a tab that takes the polling over never books it twice. Settings → Data never deletes a running run, an open job, a finished job whose run is still running, or the saved state of a tool that has one: a delivery may still need them. Notifications are opt-in: `jobs.add({ …, notify: true })`, or `'group'` for one per group. A deliberate "Stop waiting" ends the run with `run.cancel(reason)` (aborted, not an error).

Show progress with `jobList()` + `bindJobList(ctx.jobs, list, { tool: ctx.manifest.id })`. Work that only lives in this page until a later step (a sequence being assembled, parts not yet joined) is protected with `ui.holdWork(description)`. Handed-off runs do not count for the leave guard: the job carries on without the page.

## Stored state

`ctx.state` keeps JSON in IndexedDB. Rules for a value several tabs (or a tab and its own late writes) change:

- **Read-modify-write with `update`.** `ctx.state.update(key, (current) => next)` runs under the Web Lock `ortoolbox:tool-state:<tool>:<key>`, so two tabs never lose each other's change (a vote tally, a list of saved items). Return `current` itself to write nothing, `undefined` to delete; it resolves with the stored value. It waits only for other `update`s of the key, so write such a key through `update` alone.
- **Re-read on `tool-state-changed`** and show what is stored (see the context table). A data reset, "Delete all prompts and history" and a backup import announce every key they touch, so a page that follows the event shows them.
- **A reset is final.** After Reset everything (in any tab), the store refuses (`StateResetError`, shown as "reload the page") to store a value from before it: a key this page read or wrote before the reset and has not read since, or an object it read or stored before. So the abort a reset causes cannot write the old conversation back, even a write already on its way when the reset happened: the check runs in the write's own transaction against a reset generation that Reset bumps while it wipes, so you need no extra delete behind your writes. Deletes, new keys and values built after a fresh read are stored. To go on in an open page after a reset, drop what you hold on `data-reset` (`ctx.bus.on('data-reset', …)`) and read again.
- **Locks of your own** come from `src/core/util.ts`: `lockRunner(name)` for short locked steps (make it once, then `locked(fn)`: the Web Lock plus the runner's own in-page queue, which also serves where Web Locks are missing), `holdLock(name, { ifAvailable })` for a lock held as long as something lives (it resolves with the release, or null when another tab holds it). Name them `ortoolbox:<tool>:…`.

## Prompts, History and the form state

`getState()` returns the main text as `prompt` and **every other setting** as JSON-safe `settings`; `applyState()` must restore the form exactly from that (ignore keys you do not know: older snapshots exist). The framework uses the pair for:

- Prompts panel: Save current (`getState`), Use (`applyState`), Recent entries (written by `runs.begin` from the `prompt`/`settings` that `beginRun` takes from `getState()`);
- History: `?run=<id>` reopens a run's prompt and settings;
- the stored run record (`settings` is what History shows and what "re-run" restores).

Test the round trip (`applyState(getState())` changes nothing, and `getState()` after `applyState(x)` equals `x`).

A tool that works on files and settings only, with no main text field, sets `promptless: true` on its instance: `getState().prompt` stays `''`, and Prompts' "Save current" saves named settings presets (no Copy, no Recent entries).

## Files in and out

- **Drop and paste:** implement `onFiles(files)`. From the moment the page starts, every file drag over it is caught (a stray drop never opens the file and leaves the page). While your tool takes files (`onFiles` and a non-empty `accepts`), a page-wide overlay shows during the drag; only files matching `manifest.accepts` (wildcards and extension fallback) reach `onFiles`, and skipped ones are named in a toast. A tool without `onFiles` answers a drop with "<Tool> doesn't take files." A paste into a text field that carries text is left to the field.
- **Handle files by type.** `accepts` can mix text, images and PDFs: branch on `file.type` (with the extension as fallback). `readAsText` only for text; images go to the model as data URLs (`readAsDataUrl`); PDFs through `openPdf` (dynamic import, see Media). Never read a binary file as text.
- **Drop zone:** `dropZone({ accept, multiple, onFiles })` for an explicit target with a keyboard-reachable "Choose files" button.
- **Send to…:** `ctx.ui.sendTo([{ kind: 'text', text, type: 'text/markdown' }, { kind: 'file', blob, name }])` lists tools whose `accepts` match and opens the chosen one in a new tab; the items travel in memory over a BroadcastChannel handshake (nothing is stored). The target receives them in `onReceive`. `outputPanel({ sendTo: ctx.ui.sendTo })` wires its own button.

## Shared components (`src/ui/components/`)

| Component | Use it for |
| --- | --- |
| `dropZone(options)` | File input target (drag, keyboard, accept filter); its Choose files button keeps focus across rebuilds (`focusKey`, default `drop-zone`). |
| `attachmentChip({ ref, data?, missing?, remove? })` | One file sent with a chat request (thumbnail or kind icon, name, size, optional Remove). The files themselves: `src/core/attachments/` (`readAttachment`, `toContentPart`, `missingInput`, `parserAddons`, `keepParsed`), as Chat and Model arena use them. |
| `attachmentIntake({ noun, files, setFiles, keep, field, changed })` | How a request takes files in: `addFiles(files)` for `onFiles`, `receive(items)` for `onReceive` (named text and files become attachments, other text goes into `field`), `attach(ref, data?)`. The count and size limits, one warning for everything refused and the wording (one `noun`: "message", "prompt") are shared; `changed()` is where the tool redraws its chips and refreshes its estimate. Chat's composer uses it. |
| `createMarkdownCache({ size?, decorate? })` | Rendered, sanitised Markdown of finished messages, so a redraw parses nothing again: `fill(target, key, text)` (the cached render at once, else plain text until it is ready; a slow render never overwrites a newer text), `prerender(key, text)` when a message finishes, `render`, `cached`. `decorate(fragment)` runs once per fresh render (Chat adds code Copy buttons). One cache per tool; a message still arriving streams through `streamMarkdown`. |
| `referencePicker({ ui, min?, max, accepts?, label?, ... })` | Reference images for a request: drop zone, small thumbnails (`imageThumbnail`), remove with focus management, a limits note (`setLimits` when the model changes, `problem()`), `add(items)` for Send to, paste and "use as reference". `dataUrls({ maxSide, maxBytes })` encodes each reference once and caches it until the limits change. |
| `compareSlider(...)` | A before/after wipe (keyboard and pointer). |
| `documentInput(options)` | Images and PDFs with thumbnails and page choice (`1-3, 7`, tile toggles); `selection()` lists pages, `loadPage(ref)` renders one for upload (`{ fileName, pageNumber, imageDataUrl, text? }`), `pageImage`/`reveal` show the source. Pair with `runItems()` for per-page requests. |
| `modelPicker(ctx, { capability, selected })` → `Promise<string \| null>` | Extra model choices (arena contenders, bot B, a secondary capability). The header chip covers the primary capability only. |
| `keyPicker({ keys, value, onChange, focusKey? })` | A key choice beyond the header's. |
| `costBadge(usd?, note?)` | An estimate pill for a sub-part (e.g. per sequence step). |
| `outputPanel(options)` | Streaming text or Markdown with Copy, Download, Send to…. |
| `streamMarkdown(target, options)` | The output panel's streaming renderer without the panel, for custom layouts. |
| `exportMenu({ filename, formats, resultIds })` | Lazily built downloads in several formats; `update(…)` changes it in place. |
| `imageViewer({ src \| blob, alt })` | Fit/zoom, checkerboard behind transparency. |
| `videoResultCard({ ui, blob, name, seconds?, meta, covers?, onRemove, beforeRemove?, focusFallback?, ... })` | One video result: player, Download (`covers` marks the results it includes as downloaded too), Send to…, Remove (asks while not downloaded) with the card focus contract, leave guard through `ui.addResult`. Returns `{ element, handle, player, remove() }`. |
| `audioResultCard({ ui, blob, name, seconds?, peaks?, metaParts, formats, onRemove, ... })` | One audio result (a recording, joined speech, a song): player, downloads (the file as it is plus converted `formats`), Send to…, Remove with focus management, registered with the leave guard through `ui.addResult`. Returns `{ element, handle, player, remove() }`. |
| `imageResultCard({ ui, blob, name, meta, formats, onRemove, actions?, viewer?, ... })` | One image result (a generated image, an edited version): viewer, downloads (the file as it is plus `formats` converted through a canvas: `png`, `jpg`, `webp`), Send to…, the tool's own `actions` (`{ label, icon, ariaLabel, onClick, testId }`), Remove with focus management, registered with the leave guard through `ui.addResult`. `viewer: false` for a page that already shows the image (an editor canvas). Returns `{ element, handle, viewer, remove() }`. `focusFallback` runs after `onRemove` has updated the page; a format the browser cannot encode (WebP in Safari) is left out of the menu; SVG downloads only as it is. |
| `progressBar({ label, hidden?, class?, testId? })` | A labelled `role="progressbar"`; `update(done, total, text?)` (text becomes `aria-valuetext`). Pair it with `ui.progress`. |
| `audioPlayer({ src \| blob, peaks?, label })` | Native controls plus a waveform (`peaks()` from `src/core/media/audio`, or decoded lazily at 8 kHz mono; none beyond 30 minutes). Pass `seconds` when you know the length (nothing is measured); recordings whose duration reads as Infinity are probed before seeking. |
| `videoPlayer({ src \| blob, label })` | Native controls in a letterboxed frame. |
| `jobList(options)` + `bindJobList(...)` | Persistent jobs with progress. |
| `emptyState({ icon, title, text, action, compact, inline })` | Every "nothing yet" place. |
| `connectKey(options)` | Connect with OpenRouter / paste a key (onboarding, the no-key dialog). |

Feedback (`src/ui/feedback/`): `toast({ message, variant, action, timeoutMs })` (a toast with an action stays until dismissed), `confirmDialog`, `typedConfirm({ phrase })` (destructive data actions), `promptDialog`, `unlockDialog()`, `presentError(error, { retry })`, `announce(text)`, `setFieldError(input, feedback, message | null)` (field validation: `is-invalid`, `aria-invalid`, `aria-describedby`, announced), and `openModal(options)` for anything custom (one modal at a time, later ones queue; await `closed`). Formatting: `src/ui/format.ts` (`formatUsd`, `formatEstimate`, `formatTokens`, `formatMs`, `formatBytes`, `formatDuration`, `formatRelativeTime`, `formatModelPrice`, `plural`, and the cost wording below). Links: `src/ui/shell/links.ts` (`toolUrl`, `settingsUrl(section)`, `historyUrl`, `modelsUrl`).

**What a run cost** has one rule, `describeRunCost(cost, { free?, booked? })` in `src/ui/format.ts`: unknown first (never free, never zero, never `≈`; `{ kind: 'unknown', text: 'Unknown', counted: '≈ $0.0034' }` says what budgets counted for it, `booked` being the run's reservation), then free (a zero cost on a free model), then estimated (`≈ $0.012`), else the reported amount. `formatRunCost` is the same as one string (`Unknown (≈ $0.0034 counted)`), and `usageLine(usage, { free?, booked? })` is the line under a reply (`1.2K in · 340 out · cost unknown · 1.4 s`). Take `free` from `ctx.models.isFree(model)`; do not word costs yourself.

**Small icon-only buttons** (Remove, Copy, Edit) are `btn btn-sm btn-link or-icon-action` with an `aria-label`: 2 rem square, muted, stronger on hover and focus.

**Re-rendering a list** (results, saved items, chips): give each focusable control a stable `data-focus-key` (for example `` `remove:${item.id}` ``) and swap the children with `replace(container, ...children)` from `src/ui/dom.ts`. Focus moves to the new element with the same key; when that one is gone or disabled (a Retry button while busy), to the nearest keyed control that can take focus, else to the first focusable element in the container. Bootstrap dropdowns, collapses and toasts inside the old children are disposed. For a single node you swap yourself: `const key = focusedKey(card); card.replaceWith(next); if (key) focusKey(next, key);`. Never key focus on `data-testid`, and better still, update a control in place (attributes, text) when only its state changes.

## Media and heavy libraries

- **Lazy only.** Anything heavy loads with `import()` when first needed, and the manifest lists it in `lazyLibs` (a unit test checks they are dependencies). Budget: each tool adds at most 80 KB gzipped JS to the shell's 150 KB; check the `npm run build` output.
- **PDF:** import `src/core/media/pdf.ts` dynamically only (`const { openPdf } = await import('../../core/media/pdf')`); it brings about 5 MB of pdf.js assets.
- **Audio:** join TTS or audio segments with `stitchAudio(segments, 'mp3' | 'wav')` (`src/core/media/stitch.ts`: decode → PCM → encode once; a single segment already in the target format comes back as it is, without loading anything). Plain MP3 concatenation leaves gaps at the seams. Convert a file with `transcode(blob, 'mp3' | 'wav')` (`src/core/media/transcode.ts`, loads ffmpeg only when called).
- **Images:** run heavy pixel work in the worker (`src/core/media/image-async.ts`: `isolateImage`, `maskOverlayAsync`, `maskToRasterAsync`, `featherInsideAsync`, `compositeMaskedAsync`, each with `{ signal, transfer }` and a page fallback), never pixel loops on the main thread. A failed worker is recreated on the next job; after three failures in a row the page does the work. Encode references that belong together (marked, plain, mask) with `toDataUrls(images, options)`, at one pixel size; `readImageSize(blob)` reads dimensions from the file header without decoding.
- **Image models:** ask `ctx.models.imageControls(model)`: `ready` (send only the fields its `controls` list), `missing` (refuse before the run) or `unknown` (the list could not be read: send `controls`, the bare prompt-only set, and let the request try). Estimates with references pass `requests` (how many requests upload them).
- **ZIP:** `zipFiles()` from `src/core/export`, or fflate's `zipSync`. Never fflate's async API (`zip`, `unzip`, `deflate`): it starts `blob:` workers that the CSP blocks, and then never settles.
- **ffmpeg:** go through `src/core/media/ffmpeg-ops.ts` (`concatVideos` refuses a clip or a result over `MAX_JOIN_BYTES`, 1.5 GiB, before encoding); any `exec` of your own passes explicit `-threads` limits (multi-threaded ffmpeg crashes on H.264 encodes with the default count).

## Rules that bite

- The Run bar is sticky at the bottom of the window; the framework keeps focused controls clear of it (scroll padding, plus a correction after Tab). Do not add sticky footers of your own in the input zone.

- DOM only through `h()`; model output only through `renderMarkdown()` (the output panel does it). No `innerHTML`, no inline styles in strings, no remote `src` (load remote media with `fetch` → Blob → object URL).
- No `fetch` to OpenRouter and no storage access: go through `ctx`.
- Element ids: generate them with `uid()` (`src/ui/id.ts`); a page can hold several instances.
- `hidden` is safe on any element (a global rule beats Bootstrap's display utilities).

## Accessibility

Every control has a visible label (or `aria-label` for icon buttons), everything works with the keyboard (Tab order follows the layout; Ctrl/Cmd+Enter runs), focus is visible, status changes go through `ui.status()` / `announce()` rather than new live regions, field errors through `setFieldError`, and colours come from Bootstrap's variables so both themes and custom accents keep AA contrast. Do not move focus unexpectedly; dialogs return focus to their opener, and re-rendered controls keep it through `data-focus-key`.

## Testing

- **Convention:** the tool's main prompt field (the one `getState().prompt` reads) carries `data-testid="tool-prompt"`. Shared specs (Prompts, onboarding's sample) find it there. A tool without one declares `promptless: true` on its instance.
- **Unit** (`src/tools/<id>/*.test.ts`, Vitest + jsdom): pipeline logic, request building, parsing, and the tool itself through `createToolTestContext` (`src/ui/tool/testing.ts`). It builds a real `ToolContext` (the same `createToolContext` as the page) over the fake core: real settings, runs, history and models services on fake IndexedDB, one fake key, and an API client whose calls throw unless you provide them.

  ```ts
  import 'fake-indexeddb/auto';
  import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
  import { createToolTestContext } from '../../ui/tool/testing';

  beforeEach(async () => {
    isolateChannels();
    await resetDb();
    localStorage.clear();
  });

  it('round-trips its state and books its estimate', async () => {
    const t = createToolTestContext(getTool('chat'), { catalog: [model], api: { chatStream } });
    const tool = await t.mount(setup);
    const state = { prompt: 'Summarise this', settings: { length: 'long', temperature: 0.3 } };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    await t.ctx.ui.refreshEstimate();
    expect(t.estimate()).toBeGreaterThan(0);
    await t.runners[0]!.trigger(); // runs through ctx.beginRun and your mocked chatStream
    t.cleanup();
  });
  ```

  Options: `catalog` (models the models service serves), `api` (calls to mock), `modelOverride` (`?model=`), `noKey`. The result also exposes `core`, `keyState`, `zones`, `sent` (Send to… items) and `status()`.
- **E2E** (`tests/e2e/<id>.spec.ts`): `watchForProblems(page, { allowAborted: ['/api/v1/…'] })` lists the paths whose aborts the app causes on purpose (Stop, a stream cancelled after `[DONE]`); `<audio>`/`<video>` aborts of `blob:` reads are ignored for every spec. import `test`/`expect` from `tests/mock/index.ts`; mock every OpenRouter call (`mock.json`, `mock.sse` for streams, `mock.file` for media, `mock.sequence` for polling), seed state with `seedApp(context, { key: true })` from `tests/e2e/app.ts`, and assert `watchForProblems(page)` is empty. Cover: a run end to end with the output, the error path (`mock.json(..., { status: 429 })`), Stop, drop/paste of an accepted file, and the prompts round trip (save current → Use restores the form). `tests/e2e/routes.spec.ts` already runs axe on your page in light and dark.

## Worked example

A complete small tool, type-checked and unit-tested against the framework while this guide was written (as `src/tools/chat/main.ts`). It summarises text: input, a drawer option and an advanced option, an estimate through the hook, streaming output, drop/paste by file type, Send to…, a sample and the prompts round trip.

```ts
import { readAsText } from '../../core/files';
import { outputPanel } from '../../ui/components/output-panel';
import { h } from '../../ui/dom';
import { presentError } from '../../ui/feedback/errors';
import { plural } from '../../ui/format';
import { uid } from '../../ui/id';
import { mountTool, type ToolContext, type ToolInstance } from '../../ui/tool/index';
import { getTool } from '../registry';

type Length = 'short' | 'medium' | 'long';
const MAX_TOKENS: Record<Length, number> = { short: 200, medium: 500, long: 1200 };
const isLength = (value: unknown): value is Length =>
  value === 'short' || value === 'medium' || value === 'long';
const isText = (file: File): boolean =>
  file.type.startsWith('text/') || /\.(txt|md|markdown)$/i.test(file.name);

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  const ids = { text: uid('text'), length: uid('length'), temperature: uid('temperature') };

  const text = h('textarea', {
    id: ids.text,
    class: 'form-control',
    rows: 10,
    placeholder: 'Paste text or drop a .txt file',
    'data-testid': 'tool-prompt',
  });
  ui.input.append(h('label', { class: 'form-label fw-semibold', htmlFor: ids.text }, 'Text'), text);

  const length = h(
    'select',
    { id: ids.length, class: 'form-select' },
    h('option', { value: 'short' }, 'Short'),
    h('option', { value: 'medium' }, 'Medium'),
    h('option', { value: 'long' }, 'Long'),
  );
  const savedLength = ctx.options.get()['length'];
  length.value = isLength(savedLength) ? savedLength : 'medium';
  ui.drawer.append(h('label', { class: 'form-label', htmlFor: ids.length }, 'Length'), length);

  const temperature = h('input', {
    id: ids.temperature,
    type: 'number',
    class: 'form-control',
    min: '0',
    max: '2',
    step: '0.1',
    value: '0.3',
  });
  ui.advanced('Sampling').append(
    h('label', { class: 'form-label', htmlFor: ids.temperature }, 'Temperature'),
    temperature,
  );

  const output = outputPanel({ format: 'markdown', filename: 'summary', sendTo: ui.sendTo });
  ui.output.append(output.element);

  const settings = () => ({
    length: isLength(length.value) ? length.value : 'medium',
    temperature: Number(temperature.value),
  });

  text.addEventListener('input', () => void ui.refreshEstimate());
  length.addEventListener('change', () => {
    ctx.options.set({ length: length.value });
    void ui.refreshEstimate();
  });

  ui.runner({
    label: 'Summarise',
    icon: 'text-paragraph',
    run: async (signal) => {
      if (!text.value.trim()) {
        ui.status('Add some text first.');
        text.focus();
        return;
      }
      const run = await ctx.beginRun({}, signal); // books the header's estimate
      output.start();
      try {
        const result = await ctx.api.chatStream(
          {
            model: run.model,
            messages: [
              { role: 'system', content: `Summarise the user's text (${settings().length}), as Markdown.` },
              { role: 'user', content: text.value },
            ],
            max_tokens: MAX_TOKENS[settings().length],
            temperature: settings().temperature,
          },
          {
            run,
            onEvent: (event) => {
              if (event.type === 'text') output.append(event.text);
            },
          },
        );
        output.finish();
        await run.finish({ output: result.text });
      } catch (error) {
        output.fail(error); // Stop: "Stopped", partial kept; other errors inline, once
        await run.fail(error);
        throw error; // the runner skips what the panel showed and handles keys, budgets…
      }
    },
  });

  return {
    getState: () => ({ prompt: text.value, settings: settings() }),
    applyState: ({ prompt, settings: saved }) => {
      text.value = prompt;
      if (isLength(saved['length'])) length.value = saved['length'];
      if (typeof saved['temperature'] === 'number') temperature.value = String(saved['temperature']);
      void ui.refreshEstimate();
    },
    estimate: (model) =>
      ctx.models.estimate({
        kind: 'tokens',
        model,
        promptTokens: Math.ceil(text.value.length / 4) + 50,
        completionTokens: MAX_TOKENS[settings().length],
      }),
    onFiles: (files) => {
      // Chat's manifest also accepts images and PDFs; this example reads text files only.
      const skipped = files.filter((file) => !isText(file));
      if (skipped.length > 0) ui.status(`${plural(skipped.length, 'file')} skipped: only text files are read.`);
      Promise.all(files.filter(isText).map((file) => readAsText(file)))
        .then((parts) => {
          text.value = [text.value, ...parts].filter(Boolean).join('\n\n');
          void ui.refreshEstimate();
        })
        .catch((error: unknown) => void presentError(error));
    },
    onReceive: (items) => {
      for (const item of items) if (item.kind === 'text') text.value = item.text;
      void ui.refreshEstimate();
    },
    sample: () => {
      text.value = 'ORtoolbox runs in your browser. Paste one OpenRouter key and every tool works.';
      void ui.refreshEstimate();
    },
  };
}

mountTool(getTool('chat'), setup);
```

## Checklist

1. Write `setup` in `src/tools/<id>/` (split into modules as it grows); keep `main.ts` to the `mountTool` call, and the manifest's `accepts`, `capabilities` (primary first) and `lazyLibs` true to what the tool does.
2. Main prompt field: `data-testid="tool-prompt"`. Implement `getState`/`applyState` (exact round trip), `estimate` (and call `ui.refreshEstimate()` on input changes), `sample()` (onboarding offers it), and `onFiles`/`onReceive` if the manifest accepts anything.
3. Follow the error rule: `output.fail(error)` / `run.fail(error)` / rethrow; `presentError` outside the runner. Call `beginRun` before touching tool state; batches go through `runItems`, per-item Retry through `runner.trigger(arg)`, paid extras (the PDF parser) through `addons()`.
4. Media: lazy imports, `stitchAudio`, `isolateImage`, `zipFiles`/`zipSync`, explicit ffmpeg `-threads`; stay inside the 80 KB budget.
5. Tests: unit tests for the pipeline and the tool through `createToolTestContext`, and an e2e spec against the mock (run, error, Stop, files, prompts round trip).
6. Check the page in both themes at 320 px and on a desktop, with the keyboard only.
