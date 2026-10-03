# Building a tool

How to build one of the 14 tools on the Stage 2 shell. Read [CLAUDE.md](../CLAUDE.md) first (architecture rules and conventions are binding) and [openrouter-api.md](openrouter-api.md) for the endpoint you call. Every tool page today renders through `mountTool` with the stand-in `comingSoon` instance; building a tool means replacing that instance with your own.

## The contract in one screen

```text
src/tools/<id>/manifest.json   static half: name, icon, category, capabilities (first = primary), accepts, produces, defaults
src/tools/<id>/main.ts         mountTool(getTool('<id>'), setup)          ← the only line that must stay
src/tools/<id>/*.ts            your pipeline, UI pieces and *.test.ts (never import another tool's folder)
```

```ts
mountTool(manifest: ToolManifest, setup: ToolSetup, options?: { isolation?: 'required' }): void
type ToolSetup = (ctx: ToolContext) => ToolInstance | Promise<ToolInstance>;

interface ToolInstance {
  getState(): ToolSnapshot;                  // { prompt: string; settings: Record<string, unknown> }
  applyState(state: ToolSnapshot): void;      // must reproduce exactly what getState() returned
  onFiles?(files: File[]): void;              // page-wide drop and paste, filtered by manifest.accepts
  onReceive?(items: SendItem[]): void;        // "Send to…" from another tool, filtered by manifest.accepts
  sample?(): void | Promise<void>;            // ?sample=1 and onboarding's "Try a sample"
}
```

All types live in `src/ui/tool/types.ts` and are re-exported from `src/ui/tool/index.ts`.

`mountTool` renders the page shell (navbar, palette, toasts, leave guard, budget confirmation), the tool header (icon, name, description, model chip, key chip when there are several keys, cost estimate, Prompts, Settings, History) and three empty zones, builds the context, awaits `setup`, then:

1. creates the Prompts panel around your `getState`/`applyState`;
2. calls `ctx.jobs.resume()` (register job handlers **inside** `setup`);
3. wires page-wide drag-and-drop and paste to `onFiles` (only if you provide it and `accepts` is not empty);
4. applies the URL: `?run=<id>` (History → `applyState`), `?prompt=<id>` (a saved or recent prompt), `?sample=1` (`sample()`), `?receive=<id>` (Send to… hand-over → `onReceive`); these are removed from the address bar afterwards. `?model=<id>` stays and overrides the model for this visit ("re-run with another model").

Video studio passes `{ isolation: 'required' }` (multi-threaded ffmpeg). No other tool does.

## The context

`ToolContext` is every core service (`ctx.api`, `ctx.runs`, `ctx.models`, `ctx.history`, `ctx.prompts`, `ctx.jobs`, `ctx.results`, `ctx.settings`, `ctx.keys`, …; see `src/core/types.ts`) plus:

| Member | What it is |
| --- | --- |
| `manifest` | Your manifest. |
| `state` | `ToolStateStore` for this tool (IndexedDB `kv`): JSON-safe, persistent, e.g. saved deciders or a video sequence. Never binaries. |
| `options` | `{ get(), set(patch), reset() }`: `manifest.defaults` merged with the user's saved options (`settings.tools[id].options`). `set` stores only what you pass. |
| `ui` | The zones and helpers below. |
| `model(cap?)` | `ResolvedModel` for a capability (default: the primary one) through the cascade `?model=` → the header's choice (tool binding) → capability default → shipped default, with free-only applied. `model === null` means nothing may run; the framework already shows the notice and disables Run. |
| `modelOverride` | `?model=` or null. |
| `beginRun(spec, signal?)` | `runs.begin` for this tool: fills `tool`, `model` (from `ctx.model()`), `prompt` and `settings` (from your `getState()`), and aborts the run when `signal` aborts. |

`ctx.ui`:

| Member | What it does |
| --- | --- |
| `input`, `output` | The two zone bodies (`.card-body`). Input is left on wide screens, output right; they stack on narrow ones. |
| `drawer` | Body of the Settings offcanvas. Put everyday options here. |
| `advanced(title)` | Adds a collapsed accordion section at the end of the drawer and returns its body. |
| `runner({ label, icon, run, hint, container })` | The Run/Stop bar, appended to `input` (or `container`). The first runner gets Ctrl/Cmd+Enter. Returns `Runner` (`trigger`, `stop`, `setDisabled(reason)`, `busy`). |
| `setEstimate(usd \| null, note?)` | The header's estimate badge: `≈ $0.0012`, `Free` (0) or `Unknown` (null). |
| `status(text)` | A short, politely announced status in the output header ("Page 3 of 20"). |
| `addResult({ kind, name, blob })` | Registers an in-memory binary result (leave guard) and returns `{ result, button(label?), download(), remove() }`. |
| `sendTo(items)` | Opens the "Send to…" chooser for these items. |
| `openPrompts()`, `openDrawer()` | What the header buttons do. |

## Running something

Every model call belongs to a run (rule 2). The pattern, inside the runner's `run(signal)`:

```ts
const run = await ctx.beginRun({ estimateUsd: estimate, title: 'Optional history title' }, signal);
try {
  const result = await ctx.api.chat({ model: run.model, messages }, { run });   // pass { run } to every call
  await run.finish({ output: result.choices[0]?.message.content ?? '' });     // text only, never binaries
} catch (error) {
  await run.fail(error);   // AbortError → 'aborted', anything else → 'error'
  throw error;             // the runner shows it through presentError (with Retry); Stop is silent
}
```

`beginRun` (via `runs.begin`) refuses before anything is sent: no key (`no-key`: the error dialog offers Connect / paste a key, then retries), locked keys (`locked`: the unlock dialog, then retries), free-only with a paid model (`free-only`), a hard budget (`budget-blocked`). In Warn mode, or above the per-run threshold, the shell's **budget confirmation** opens by itself; Cancel throws `RunCancelledError`, which the runner treats as a quiet stop. You never handle any of this yourself: throw, and `presentError` maps `errorCode()` to the right message and action.

Long runs: `run.checkpoint({ output })` persists partial text (bot transcripts, batches). Parallel runs of one action share a `groupId` (arena contenders). A run that calls several models lists them in `models` so free-only checks them all.

### Streaming into the output panel

```ts
const output = outputPanel({ format: 'markdown', filename: 'answer', sendTo: ctx.ui.sendTo });
ctx.ui.output.append(output.element);
// in run():
output.start();                                    // skeleton until the first chunk, "Generating…" announced
await ctx.api.chatStream(body, {
  run,
  onEvent: (event) => {
    if (event.type === 'text') output.append(event.text);   // re-rendered (throttled), sanitised Markdown
  },
});
output.finish();                                   // final render, "Done · 245 words", Copy/Download/Send to… enabled
// on error: output.fail(userMessage(error)) keeps the partial text and shows the error line
```

The streamed text itself is never a live region (it would read every token); start and finish are announced.

## Cost estimates

Call `ctx.models.estimate(input)` whenever the input changes and show the result with `ctx.ui.setEstimate()`; pass the same number as `estimateUsd` to `beginRun` (budgets reserve it). The kinds (`src/core/types.ts`, `EstimateInput`): `tokens`, `speech`, `transcription`, `image`, `video`, `music`, `decision`. Estimates are deliberately high; null means unknown (shown as "Unknown"; the per-run threshold then does not apply). Free models estimate 0.

## Results, downloads and the leave guard

Images, audio, video and files stay in memory (rule 3). Register every one:

```ts
const handle = ctx.ui.addResult({ kind: 'image', name: 'product-1.png', blob });
card.append(imageViewer({ src: ctx.results.objectUrl(handle.result.id), alt: 'Product 1' }).element, handle.button());
```

`handle.button()` downloads and turns into "Downloaded". Until a result is downloaded, leaving through a link asks first (listing "3 images and 1 video not downloaded", with Download all), and reloading or closing the tab triggers the browser's own prompt. For text and table exports use `exportMenu({ filename, formats, resultIds })`: each format's Blob is built only when chosen (`toCsv`, `toXlsx`, `toDocx`, `zipFiles`, `toSrt`… from `src/core/export`), and `resultIds` marks the covered results downloaded.

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
const run = await ctx.beginRun({ estimateUsd }, signal);
const submitted = await ctx.api.videos.submit(body, { run });
const job = await ctx.jobs.add<VideoPayload, VideoResult>({
  tool: ctx.manifest.id,
  type: 'video',
  payload,
  keyId: run.keyId,
  remoteId: submitted.id,
  runId: run.id,
});
run.handOff(job.id); // from now on unload and Stop do not finalise the run

// finishing it, wherever you observe completion (also after a reload, or in another tab):
ctx.jobs.subscribe((record) => {
  const job = record as JobRecord<VideoPayload, VideoResult>;
  if (job.state !== 'succeeded' || !job.runId || !job.result) return;
  void ctx.runs.reattach(job.runId).then(async (run) => {
    if (!run) return; // already final
    // Video cost arrives only on the completed status read; the run books it.
    run.addUsage({
      model: run.model,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: job.result!.costUsd ?? 0,
      costEstimated: false,
      costUnknown: job.result!.costUsd === null,
      latencyMs: job.updatedAt - job.createdAt,
    });
    await run.finish({ meta: { videoJobIds: [job.remoteId] } });
  });
});
```

Show progress with `jobList()` + `bindJobList(ctx.jobs, list, { tool: ctx.manifest.id })`.

## Prompts, History and the form state

`getState()` returns the main text as `prompt` and **every other setting** as JSON-safe `settings`; `applyState()` must restore the form exactly from that (ignore keys you do not know: older snapshots exist). The framework uses the pair for:

- Prompts panel: Save current (`getState`), Use (`applyState`), Recent entries (written by `runs.begin` from the `prompt`/`settings` that `beginRun` takes from `getState()`);
- History: `?run=<id>` reopens a run's prompt and settings;
- the stored run record (`settings` is what History shows and what "re-run" restores).

Test the round trip (`applyState(getState())` changes nothing, and `getState()` after `applyState(x)` equals `x`).

## Files in and out

- **Drop and paste:** implement `onFiles(files)`; the framework shows a page-wide overlay while files are dragged over the page, filters by `manifest.accepts` (wildcards and extension fallback) and names skipped files in a toast. A paste into a text field that carries text is left to the field.
- **Drop zone:** `dropZone({ accept, multiple, onFiles })` for an explicit target with a keyboard-reachable "Choose files" button.
- **Send to…:** `ctx.ui.sendTo([{ kind: 'text', text, type: 'text/markdown' }, { kind: 'file', blob, name }])` lists tools whose `accepts` match and opens the chosen one in a new tab; the items travel in memory over a BroadcastChannel handshake (nothing is stored). The target receives them in `onReceive`. `outputPanel({ sendTo: ctx.ui.sendTo })` wires its own button.

## Shared components (`src/ui/components/`)

| Component | Use it for |
| --- | --- |
| `dropZone(options)` | File input target (drag, keyboard, accept filter). |
| `modelPicker(core, { capability, selected })` → `Promise<string \| null>` | Extra model choices (arena contenders, bot B). The header chip already covers the primary capability. |
| `keyPicker({ keys, value, onChange })` | A key choice beyond the header's. |
| `costBadge(usd?)` | An estimate pill for a sub-part (e.g. per sequence step). |
| `outputPanel(options)` | Streaming text or Markdown with Copy, Download, Send to…. |
| `exportMenu({ filename, formats, resultIds })` | Lazily built downloads in several formats. |
| `imageViewer({ src \| blob, alt })` | Fit/zoom, checkerboard behind transparency. |
| `audioPlayer({ src \| blob, peaks?, label })` | Native controls plus a waveform (`peaks()` from `src/core/media/audio`, or decoded lazily). |
| `videoPlayer({ src \| blob, label })` | Native controls in a letterboxed frame. |
| `jobList(options)` + `bindJobList(...)` | Persistent jobs with progress. |
| `emptyState({ icon, title, text, action, compact, inline })` | Every "nothing yet" place. |
| `connectKey(options)` | Connect with OpenRouter / paste a key (onboarding, the no-key dialog). |

Feedback (`src/ui/feedback/`): `toast({ message, variant, action, timeoutMs })`, `confirmDialog`, `typedConfirm({ phrase })` (destructive data actions), `promptDialog`, `unlockDialog()`, `presentError(error, { retry })`, `announce(text)`, and `openModal(options)` for anything custom (one modal at a time; await `closed`). Formatting: `src/ui/format.ts` (`formatUsd`, `formatEstimate`, `formatTokens`, `formatMs`, `formatBytes`, `formatDuration`, `formatRelativeTime`, `formatModelPrice`, `plural`). Links: `src/ui/shell/links.ts` (`toolUrl`, `settingsUrl(section)`, `historyUrl`, `modelsUrl`).

## Rules that bite

- DOM only through `h()`; model output only through `renderMarkdown()` (the output panel does it). No `innerHTML`, no inline styles in strings, no remote `src` (load remote media with `fetch` → Blob → object URL).
- No `fetch` to OpenRouter and no storage access: go through `ctx`.
- Element ids: generate them with `uid()` (`src/ui/id.ts`); a page can hold several instances.
- `hidden` is safe on any element (a global rule beats Bootstrap's display utilities).
- Heavy libraries load with `import()` when first needed (`src/core/media/pdf.ts`, ffmpeg, docx, xlsx).

## Accessibility

Every control has a visible label (or `aria-label` for icon buttons), everything works with the keyboard (Tab order follows the layout; Ctrl/Cmd+Enter runs), focus is visible, status changes go through `ui.status()` / `announce()` rather than new live regions, and colours come from Bootstrap's variables so both themes and custom accents keep AA contrast. Do not move focus unexpectedly; dialogs return focus to their opener.

## Testing

- **Unit** (`src/tools/<id>/*.test.ts`, Vitest + jsdom): pipeline logic, request building, parsing, the `getState`/`applyState` round trip. `src/core/testing/state-fakes.ts` and `src/core/api/test-fakes.ts` give real services over fake IndexedDB and channels.
- **E2E** (`tests/e2e/<id>.spec.ts`): import `test`/`expect` from `tests/mock/index.ts`; mock every OpenRouter call (`mock.json`, `mock.sse` for streams, `mock.file` for media, `mock.sequence` for polling), seed state with `seedApp(context, { key: true })` from `tests/e2e/app.ts`, and assert `watchForProblems(page)` is empty. Cover: a run end to end with the output, the error path (`mock.json(..., { status: 429 })`), Stop, drop/paste of an accepted file, and the prompts round trip (save current → Use restores the form). `tests/e2e/routes.spec.ts` already runs axe on your page in light and dark.

## Worked example

A complete small tool, compiled and run against the shell while this guide was written (as `src/tools/chat/main.ts`). It summarises text: input, a drawer option and an advanced option, a live estimate, streaming output, drop/paste, Send to…, samples and the prompts round trip.

```ts
import { userMessage } from '../../core/errors';
import { readAsText } from '../../core/files';
import { outputPanel } from '../../ui/components/output-panel';
import { h } from '../../ui/dom';
import { uid } from '../../ui/id';
import { mountTool, type ToolContext, type ToolInstance } from '../../ui/tool/index';
import { getTool } from '../registry';

type Length = 'short' | 'medium' | 'long';
const MAX_TOKENS: Record<Length, number> = { short: 200, medium: 500, long: 1200 };
const isLength = (value: unknown): value is Length => value === 'short' || value === 'medium' || value === 'long';

function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  const ids = { text: uid('text'), length: uid('length'), temperature: uid('temperature') };

  const text = h('textarea', { id: ids.text, class: 'form-control', rows: 10, placeholder: 'Paste text or drop a .txt file' });
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

  const temperature = h('input', { id: ids.temperature, type: 'number', class: 'form-control', min: '0', max: '2', step: '0.1', value: '0.3' });
  ui.advanced('Sampling').append(h('label', { class: 'form-label', htmlFor: ids.temperature }, 'Temperature'), temperature);

  const output = outputPanel({ format: 'markdown', filename: 'summary', sendTo: ui.sendTo });
  ui.output.append(output.element);

  const settings = () => ({ length: length.value as Length, temperature: Number(temperature.value) });

  let estimate: number | null = null;
  const updateEstimate = async (): Promise<void> => {
    const model = ctx.model().model;
    estimate = model
      ? await ctx.models.estimate({
          kind: 'tokens',
          model,
          promptTokens: Math.ceil(text.value.length / 4) + 50,
          completionTokens: MAX_TOKENS[settings().length],
        })
      : null;
    ui.setEstimate(estimate);
  };
  text.addEventListener('input', () => void updateEstimate());
  length.addEventListener('change', () => {
    ctx.options.set({ length: length.value });
    void updateEstimate();
  });
  void updateEstimate();

  ui.runner({
    label: 'Summarise',
    icon: 'text-paragraph',
    run: async (signal) => {
      if (!text.value.trim()) {
        ui.status('Add some text first.');
        text.focus();
        return;
      }
      const run = await ctx.beginRun({ estimateUsd: estimate }, signal);
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
        output.fail(userMessage(error));
        await run.fail(error);
        throw error;
      }
    },
  });

  return {
    getState: () => ({ prompt: text.value, settings: settings() }),
    applyState: ({ prompt, settings: saved }) => {
      text.value = prompt;
      if (isLength(saved['length'])) length.value = saved['length'];
      if (typeof saved['temperature'] === 'number') temperature.value = String(saved['temperature']);
      void updateEstimate();
    },
    onFiles: (files) => {
      void Promise.all(files.map((file) => readAsText(file))).then((parts) => {
        text.value = [text.value, ...parts].filter(Boolean).join('\n\n');
        void updateEstimate();
      });
    },
    onReceive: (items) => {
      for (const item of items) if (item.kind === 'text') text.value = item.text;
      void updateEstimate();
    },
    sample: () => {
      text.value = 'ORtoolbox runs in your browser. Paste one OpenRouter key and every tool works.';
      void updateEstimate();
    },
  };
}

mountTool(getTool('chat'), setup);
```

## Replacing the stand-in

1. Write `setup` in `src/tools/<id>/` (split into modules as it grows); keep `main.ts` to the `mountTool` call.
2. Remove the `comingSoon` import from your `main.ts`. When the last tool is done, delete `src/ui/tool/coming-soon.ts`.
3. Give the tool a `sample()` (onboarding offers it), unit tests for the pipeline and the state round trip, and an e2e spec against the mock.
4. Check the page in both themes at 320 px and on a desktop, with the keyboard only.
