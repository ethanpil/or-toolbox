/**
 * Diagnostics: shows whether this browser, on this host, has what
 * multi-threaded ffmpeg.wasm needs, and proves it by running ffmpeg.
 *
 * This page is the Stage 0 gate on the real GitHub Pages URL, and the e2e
 * tests read it too, so every value has a `data-testid` and a machine-readable
 * `data-value`.
 */
import { boot } from '../core/boot';
import { type FfmpegDownloadProgress, loadFfmpeg } from '../core/media/ffmpeg';
import { url } from '../core/paths';
import { getServiceWorkerReport, type ServiceWorkerReport } from '../core/sw-register';
import { clear, h } from '../ui/dom';
import { renderStubPage } from '../ui/stub';

// --- environment ------------------------------------------------------------

interface Row {
  label: string;
  testId: string;
  /** Machine-readable, for tests. */
  value: string;
  /** Human-readable; defaults to `value`. */
  text?: string;
  /** Colours the value: true = good, false = bad, undefined = neutral. */
  ok?: boolean;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function serviceWorkerText(report: ServiceWorkerReport): string {
  switch (report.state) {
    case 'unsupported':
      return 'Not available in this browser or browsing mode';
    case 'not-registered':
      return import.meta.env.PROD
        ? 'Not registered'
        : 'Not registered (the dev server has no service worker)';
    case 'installing':
      return 'Installing';
    case 'waiting':
      return 'Installed, waiting to activate';
    case 'active':
      return report.controlling
        ? 'Active and controlling this page'
        : 'Active, but not controlling this page (reload to fix)';
  }
}

async function storageRow(): Promise<Row> {
  const row = { label: 'Storage used', testId: 'diag-storage' };
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (usage === undefined || quota === undefined) throw new Error('no estimate');
    return { ...row, value: String(usage), text: `${megabytes(usage)} of ${megabytes(quota)}` };
  } catch {
    return { ...row, value: 'unknown', text: 'Not reported by this browser' };
  }
}

async function environmentRows(): Promise<Row[]> {
  const isolated = window.crossOriginIsolated;
  const sharedMemory = typeof SharedArrayBuffer === 'function';
  const sw = await getServiceWorkerReport();
  const swHealthy = sw.state === 'active' && sw.controlling;

  return [
    {
      label: 'Cross-origin isolated',
      testId: 'diag-isolated',
      value: String(isolated),
      text: isolated ? 'Yes' : 'No',
      ok: isolated,
    },
    {
      label: 'SharedArrayBuffer',
      testId: 'diag-sab',
      value: String(sharedMemory),
      text: sharedMemory ? 'Available' : 'Unavailable',
      ok: sharedMemory,
    },
    {
      label: 'Service worker',
      testId: 'diag-sw-state',
      value: swHealthy ? 'controlling' : sw.state === 'active' ? 'not-controlling' : sw.state,
      text: serviceWorkerText(sw),
      ok: swHealthy,
    },
    {
      label: 'COEP mode',
      testId: 'diag-coep-mode',
      value: sw.worker?.coepMode ?? 'none',
      text: sw.worker?.coepMode ?? 'None (no service worker is serving this page)',
    },
    {
      label: 'Offline shell',
      testId: 'diag-sw-version',
      value: sw.worker?.version ?? 'none',
      text: sw.worker ? `Build ${sw.worker.version}, ${sw.worker.precached} files` : 'None',
    },
    await storageRow(),
    {
      label: 'Logical CPU cores',
      testId: 'diag-cores',
      value: String(navigator.hardwareConcurrency),
    },
    { label: 'Site base path', testId: 'diag-base', value: url() },
    {
      label: 'Build',
      testId: 'diag-build',
      value: import.meta.env.PROD ? 'production' : 'development',
    },
    { label: 'Browser', testId: 'diag-user-agent', value: navigator.userAgent },
  ];
}

function environmentTable(rows: Row[]): HTMLElement {
  return h(
    'table',
    { class: 'table align-middle', 'data-testid': 'diag-environment' },
    h(
      'tbody',
      null,
      rows.map((row) =>
        h(
          'tr',
          null,
          h('th', { scope: 'row', class: 'w-25' }, row.label),
          h(
            'td',
            {
              class: [
                'text-break',
                row.ok === true && 'text-success',
                row.ok === false && 'text-danger',
              ],
              'data-testid': row.testId,
              'data-value': row.value,
            },
            row.text ?? row.value,
          ),
        ),
      ),
    ),
  );
}

// --- ffmpeg smoke test ------------------------------------------------------

/** Two seconds of ffmpeg's built-in test pattern, encoded to H.264 in an MP4. No input file needed. */
const SMOKE_TEST_ARGS = [
  '-f',
  'lavfi',
  '-i',
  'testsrc=duration=2:size=320x240:rate=25',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  'out.mp4',
];
const SMOKE_TEST_TIMEOUT_MS = 120_000;

type TestStatus = 'idle' | 'loading' | 'running' | 'passed' | 'failed';

function ffmpegPanel(): HTMLElement {
  const status = h(
    'span',
    { 'data-testid': 'diag-ffmpeg-status', 'data-value': 'idle' },
    'Not run',
  );
  const core = h('span', { 'data-testid': 'diag-ffmpeg-core', 'data-value': '' }, '–');
  const loadTime = h('span', { 'data-testid': 'diag-ffmpeg-load-ms', 'data-value': '' }, '–');
  const runTime = h('span', { 'data-testid': 'diag-ffmpeg-run-ms', 'data-value': '' }, '–');
  const output = h('span', { 'data-testid': 'diag-ffmpeg-output', 'data-value': '' }, '–');
  const progressBar = h('div', { class: 'progress-bar' });
  const progress = h(
    'div',
    {
      class: 'progress mb-3',
      role: 'progressbar',
      'aria-label': 'ffmpeg core download',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': 0,
      'data-testid': 'diag-ffmpeg-progress',
    },
    progressBar,
  );
  const preview = h('div', { 'data-testid': 'diag-ffmpeg-preview' });
  const log = h('pre', {
    class: 'small bg-body-tertiary border rounded p-2 mb-0',
    'data-testid': 'diag-ffmpeg-log',
  });

  const setStatus = (value: TestStatus, text: string): void => {
    status.dataset.value = value;
    status.textContent = text;
    status.className =
      value === 'passed' ? 'text-success' : value === 'failed' ? 'text-danger' : '';
  };
  const setValue = (el: HTMLElement, value: string, text = value): void => {
    el.dataset.value = value;
    el.textContent = text;
  };
  const setProgress = ({ loaded, total }: FfmpegDownloadProgress): void => {
    const percent = Math.min(100, Math.round((loaded / total) * 100));
    progressBar.style.width = `${percent}%`;
    progress.setAttribute('aria-valuenow', String(percent));
  };

  let previewUrl: string | undefined;

  const run = async (singleThread: boolean): Promise<void> => {
    for (const el of [core, loadTime, runTime, output]) setValue(el, '', '–');
    clear(preview);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    log.textContent = '';
    setProgress({ loaded: 0, total: 1 });
    setStatus('loading', 'Loading the ffmpeg core…');

    const started = performance.now();
    const { ffmpeg, multiThreaded } = await loadFfmpeg({ singleThread, onProgress: setProgress });
    const loaded = performance.now();
    setProgress({ loaded: 1, total: 1 });
    setValue(core, multiThreaded ? 'multi-threaded' : 'single-threaded');
    setValue(loadTime, String(Math.round(loaded - started)), `${Math.round(loaded - started)} ms`);

    setStatus('running', 'Encoding a 2 second test clip…');
    const lines: string[] = [];
    const onLog = ({ message }: { message: string }): void => {
      lines.push(message);
      log.textContent = lines.slice(-12).join('\n');
    };
    ffmpeg.on('log', onLog);
    try {
      const exitCode = await ffmpeg.exec(SMOKE_TEST_ARGS, SMOKE_TEST_TIMEOUT_MS);
      if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode}`);
      const data = await ffmpeg.readFile('out.mp4');
      await ffmpeg.deleteFile('out.mp4');
      if (typeof data === 'string' || data.byteLength === 0)
        throw new Error('ffmpeg wrote no output');
      // An MP4 starts with a box whose type, at bytes 4-7, is "ftyp".
      if (String.fromCharCode(...data.subarray(4, 8)) !== 'ftyp') {
        throw new Error('The output is not an MP4 file');
      }

      const elapsed = Math.round(performance.now() - loaded);
      setValue(runTime, String(elapsed), `${elapsed} ms`);
      setValue(output, String(data.byteLength), `MP4, ${data.byteLength.toLocaleString()} bytes`);
      previewUrl = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: 'video/mp4' }));
      preview.append(
        h('video', {
          class: 'rounded border mt-2',
          src: previewUrl,
          controls: true,
          muted: true,
          width: 320,
          height: 240,
        }),
      );
    } finally {
      ffmpeg.off('log', onLog);
    }
    setStatus(
      'passed',
      `Passed with the ${multiThreaded ? 'multi-threaded' : 'single-threaded'} core`,
    );
  };

  const buttons: HTMLButtonElement[] = [];
  const button = (label: string, testId: string, singleThread: boolean): HTMLButtonElement => {
    const el = h(
      'button',
      {
        type: 'button',
        class: singleThread ? 'btn btn-outline-secondary' : 'btn btn-primary',
        'data-testid': testId,
        onclick: () => {
          for (const b of buttons) b.disabled = true;
          run(singleThread)
            .catch((error: unknown) => {
              setStatus(
                'failed',
                `Failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            })
            .finally(() => {
              for (const b of buttons) b.disabled = false;
            });
        },
      },
      label,
    );
    buttons.push(el);
    return el;
  };

  const result = (label: string, value: HTMLElement): HTMLElement =>
    h('tr', null, h('th', { scope: 'row', class: 'w-25' }, label), h('td', null, value));

  return h(
    'section',
    { 'aria-labelledby': 'ffmpeg-heading' },
    h('h2', { class: 'h4 mt-4', id: 'ffmpeg-heading' }, 'ffmpeg test'),
    h(
      'p',
      null,
      'Downloads the ffmpeg core (about 32 MB, cached afterwards) and encodes a short test clip. ',
      'The automatic choice is the multi-threaded core when this page is cross-origin isolated, ',
      'and the single-threaded core otherwise.',
    ),
    h(
      'div',
      { class: 'd-flex flex-wrap gap-2 mb-3' },
      button('Run ffmpeg test', 'diag-ffmpeg-run', false),
      button('Run with the single-threaded core', 'diag-ffmpeg-run-single', true),
    ),
    progress,
    h(
      'table',
      { class: 'table align-middle' },
      h(
        'tbody',
        { 'aria-live': 'polite' },
        result('Result', status),
        result('Core', core),
        result('Load time', loadTime),
        result('Encode time', runTime),
        result('Output', output),
      ),
    ),
    preview,
    h('h3', { class: 'h6 mt-3' }, 'ffmpeg log'),
    log,
  );
}

// --- page -------------------------------------------------------------------

boot();

const environment = h('div', { 'data-testid': 'diag-environment-loading' }, 'Checking…');
renderStubPage(
  'Diagnostics',
  h(
    'p',
    { class: 'lead' },
    'What this browser supports on this site. Video joining is fastest when the page is cross-origin isolated.',
  ),
  h('h2', { class: 'h4' }, 'Environment'),
  environment,
  ffmpegPanel(),
);

void environmentRows().then((rows) => {
  environment.replaceWith(environmentTable(rows));
});
