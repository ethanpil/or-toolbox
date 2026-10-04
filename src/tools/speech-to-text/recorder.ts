/**
 * `recorder()`: microphone recording for Speech-to-text, with MediaRecorder.
 *
 * - Record asks for the microphone (the browser's own permission prompt); a refusal, a missing or busy microphone
 *   is explained inline with what to do. Without MediaRecorder or `getUserMedia` (old browsers, plain http) the
 *   button is disabled with the reason.
 * - A microphone picker appears once the browser names its microphones (after the first permission) and there is
 *   more than one; it is fixed while recording.
 * - While recording: a live level meter (decorative; the timer and the status say what happens), Pause/Resume, a
 *   timer of the time actually recorded, and Stop. Recording stops by itself at `maxSeconds` (a warning shows in
 *   the last minute), or when the microphone goes away; what was recorded is kept either way.
 * - The recording is handed to `onRecorded` as one Blob (WebM/Opus where supported, else Ogg or MP4); the page
 *   keeps it in memory.
 */
import { formatDuration } from '../../core/files';
import { h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';

export interface Recording {
  blob: Blob;
  /** Time actually recorded (pauses excluded). */
  seconds: number;
  /** File extension for the container, e.g. `webm`. */
  extension: string;
}

export interface RecorderOptions {
  /** Longest recording, in seconds. */
  maxSeconds: number;
  onRecorded: (recording: Recording) => void;
  /** Asked before the microphone is opened; false cancels (e.g. an earlier recording not downloaded yet). */
  beforeStart?: () => boolean | Promise<boolean>;
  /** Recording started or ended (the page keeps Run disabled meanwhile). */
  onBusyChange?: (busy: boolean) => void;
}

export interface Recorder {
  readonly element: HTMLElement;
  readonly busy: boolean;
  /** Stops a recording in progress and keeps what was recorded. */
  stop(): void;
  /** Releases the microphone without keeping anything (tests, teardown). */
  dispose(): void;
}

type State = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping';

/** Preferred containers, best first: Opus in WebM (Chromium, Firefox), then Ogg, then MP4 (Safari). */
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
/** The warning before the length limit. */
const WARN_SECONDS = 60;

const canRecord = (): boolean =>
  typeof MediaRecorder !== 'undefined' &&
  typeof navigator.mediaDevices?.getUserMedia === 'function';

function pickMimeType(): string {
  for (const type of MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // isTypeSupported missing or throwing: let the browser choose.
    }
  }
  return '';
}

const extensionFor = (type: string): string =>
  type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';

/** What to tell the user when the microphone does not start. */
export function microphoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow it for this site (the icon in the address bar, or the browser’s site settings), then press Record again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Connect one, then press Record again.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The microphone could not start; another app may be using it. Close that app and try again.';
  }
  return 'The microphone could not start.';
}

export function recorder(options: RecorderOptions): Recorder {
  const ids = { device: uid('stt-mic'), hint: uid('stt-rec-hint') };
  let state: State = 'idle';
  let stream: MediaStream | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let mimeType = '';
  let pieces: Blob[] = [];
  let audioContext: AudioContext | null = null;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Milliseconds recorded before the current stretch, and when the current one began. */
  let recordedMs = 0;
  let stretchStart = 0;
  let stopNote: string | null = null;
  let deviceId: string | null = null;
  let devices: MediaDeviceInfo[] = [];
  const supported = canRecord();

  const recordButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-danger d-inline-flex align-items-center gap-2',
      disabled: !supported,
      'aria-describedby': ids.hint,
      'data-testid': 'stt-record',
      onclick: () => void start(),
    },
    icon('record-circle'),
    'Record',
  );
  const pauseLabel = h('span', null, 'Pause');
  const pauseIcon = icon('pause-fill');
  const pauseButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-secondary d-inline-flex align-items-center gap-2',
      hidden: true,
      'data-testid': 'stt-record-pause',
      onclick: () => togglePause(),
    },
    pauseIcon,
    pauseLabel,
  );
  const stopButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-danger d-inline-flex align-items-center gap-2',
      hidden: true,
      'data-testid': 'stt-record-stop',
      onclick: () => finishRecording(null),
    },
    icon('stop-fill'),
    'Stop recording',
  );
  const time = h('span', {
    class: 'font-monospace fw-semibold',
    role: 'timer',
    hidden: true,
    'data-testid': 'stt-record-time',
  });
  const levelBar = h('div', { class: 'or-level-bar' });
  const level = h(
    'div',
    { class: 'or-level', hidden: true, 'aria-hidden': 'true', 'data-testid': 'stt-record-level' },
    levelBar,
  );
  const select = h('select', {
    id: ids.device,
    class: 'form-select form-select-sm',
    'data-testid': 'stt-mic',
    onchange: () => {
      deviceId = select.value || null;
    },
  });
  const deviceField = h(
    'div',
    { hidden: true },
    h('label', { class: 'form-label small mb-1', htmlFor: ids.device }, 'Microphone'),
    select,
  );
  const hint = h(
    'div',
    { id: ids.hint, class: 'small text-body-secondary', 'data-testid': 'stt-record-hint' },
    supported
      ? `Your browser asks for the microphone the first time. The recording stays in this tab (up to ${formatDuration(options.maxSeconds)}).`
      : 'Recording needs a browser with microphone recording, on a secure (https) page.',
  );
  const errorBox = h('div', {
    class: 'alert alert-warning small py-2 mb-0',
    role: 'alert',
    hidden: true,
    'data-testid': 'stt-record-error',
  });
  const element = h(
    'div',
    { class: 'vstack gap-2', 'data-testid': 'stt-recorder' },
    h(
      'div',
      { class: 'd-flex flex-wrap align-items-center gap-2' },
      recordButton,
      pauseButton,
      stopButton,
      time,
    ),
    level,
    deviceField,
    hint,
    errorBox,
  );

  const elapsedMs = (): number =>
    state === 'recording' ? recordedMs + (performance.now() - stretchStart) : recordedMs;

  const showError = (message: string | null): void => {
    errorBox.textContent = message ?? '';
    errorBox.hidden = message === null;
  };

  /** True when focus was on the recorder's buttons as they changed: it follows to the next one. */
  let keepFocus = false;
  const focusLost = (): boolean => {
    const focused = document.activeElement;
    return (
      !focused ||
      focused === document.body ||
      [recordButton, pauseButton, stopButton].some(
        (button) => button === focused && (button.hidden || button.disabled),
      )
    );
  };

  const setState = (next: State): void => {
    const was = state;
    if (next === 'starting' || next === 'stopping')
      keepFocus = element.contains(document.activeElement);
    state = next;
    const active = next === 'recording' || next === 'paused';
    recordButton.hidden = active || next === 'stopping';
    recordButton.disabled = !supported || next === 'starting';
    pauseButton.hidden = !active;
    stopButton.hidden = !active && next !== 'stopping';
    stopButton.disabled = next === 'stopping';
    pauseButton.disabled = next === 'stopping';
    pauseLabel.textContent = next === 'paused' ? 'Resume' : 'Pause';
    pauseIcon.className = `bi bi-${next === 'paused' ? 'play-fill' : 'pause-fill'}`;
    time.hidden = !active && next !== 'stopping';
    level.hidden = !active;
    select.disabled = next !== 'idle';
    // Record turns into Stop and back: keep the keyboard user's place.
    if (keepFocus && (active || next === 'idle')) {
      if (focusLost()) (next === 'idle' ? recordButton : stopButton).focus();
      keepFocus = false;
    }
    if ((was === 'idle') !== (next === 'idle')) options.onBusyChange?.(next !== 'idle');
  };

  const renderTime = (): void => {
    const seconds = Math.floor(elapsedMs() / 1000);
    const left = options.maxSeconds - seconds;
    time.textContent =
      left <= WARN_SECONDS
        ? `${formatDuration(seconds)} · ${left} s left`
        : formatDuration(seconds);
    time.classList.toggle('text-danger-emphasis', left <= WARN_SECONDS);
  };

  const tick = (): void => {
    renderTime();
    if (state === 'recording' && elapsedMs() >= options.maxSeconds * 1000) {
      finishRecording(`Recording stopped at the ${formatDuration(options.maxSeconds)} limit.`);
    }
  };

  const stopMeter = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    levelBar.style.transform = 'scaleX(0)';
    void audioContext?.close().catch(() => undefined);
    audioContext = null;
  };

  const startMeter = (source: MediaStream): void => {
    if (typeof AudioContext === 'undefined') return;
    try {
      const context = new AudioContext();
      audioContext = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(source).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const draw = (): void => {
        if (audioContext !== context) return;
        let value = 0;
        if (state === 'recording') {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          const rms = Math.sqrt(sum / samples.length);
          // -60 dBFS (silence) to 0 dBFS (full scale).
          value = Math.min(1, Math.max(0, (20 * Math.log10(rms || 1e-8) + 60) / 60));
        }
        levelBar.style.transform = `scaleX(${value.toFixed(3)})`;
        frame = requestAnimationFrame(draw);
      };
      draw();
    } catch {
      // No meter; recording works without it.
      stopMeter();
    }
  };

  /** Stops the microphone, the meter and the timer. */
  const release = (): void => {
    stopMeter();
    if (timer) clearInterval(timer);
    timer = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };

  const renderDevices = (): void => {
    const named = devices.filter((device) => device.label);
    deviceField.hidden = named.length < 2;
    replace(
      select,
      named.map((device) => h('option', { value: device.deviceId }, device.label)),
    );
    const current = named.find((device) => device.deviceId === deviceId) ?? named[0];
    if (current) select.value = current.deviceId;
    select.disabled = state !== 'idle';
  };

  const refreshDevices = async (): Promise<void> => {
    if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') return;
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === 'audioinput' && device.deviceId,
      );
    } catch {
      devices = [];
    }
    renderDevices();
  };

  const finish = (): void => {
    const type =
      (mediaRecorder?.mimeType || mimeType || 'audio/webm').split(';')[0] ?? 'audio/webm';
    const blob = new Blob(pieces, { type });
    const seconds = recordedMs / 1000;
    pieces = [];
    mediaRecorder = null;
    release();
    setState('idle');
    if (blob.size === 0) {
      showError('Nothing was recorded. Check the microphone and try again.');
      return;
    }
    showError(stopNote);
    announce(stopNote ?? `Recording stopped after ${formatDuration(seconds)}.`);
    stopNote = null;
    options.onRecorded({ blob, seconds, extension: extensionFor(type) });
  };

  function finishRecording(note: string | null): void {
    if (state !== 'recording' && state !== 'paused') return;
    if (state === 'recording') recordedMs += performance.now() - stretchStart;
    stopNote = note;
    setState('stopping');
    renderTime();
    try {
      mediaRecorder?.stop();
    } catch {
      finish();
    }
  }

  function togglePause(): void {
    if (!mediaRecorder) return;
    if (state === 'recording') {
      mediaRecorder.pause();
      recordedMs += performance.now() - stretchStart;
      setState('paused');
      announce('Recording paused.');
    } else if (state === 'paused') {
      mediaRecorder.resume();
      stretchStart = performance.now();
      setState('recording');
      announce('Recording resumed.');
    }
    renderTime();
  }

  async function start(): Promise<void> {
    if (state !== 'idle' || !supported) return;
    if (options.beforeStart && !(await options.beforeStart())) return;
    if (state !== 'idle') return;
    showError(null);
    setState('starting');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
    } catch (error) {
      setState('idle');
      showError(microphoneError(error));
      return;
    }
    void refreshDevices(); // the microphones have names now
    mimeType = pickMimeType();
    try {
      mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch {
      release();
      setState('idle');
      showError('This browser cannot record from the microphone.');
      return;
    }
    pieces = [];
    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) pieces.push(event.data);
    });
    mediaRecorder.addEventListener('stop', finish);
    mediaRecorder.addEventListener('error', () =>
      finishRecording('The recording stopped because of an error; what was recorded is kept.'),
    );
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () =>
        finishRecording('The microphone went away; what was recorded is kept.'),
      );
    }
    // A slice a second, so a long recording never sits in one buffer.
    mediaRecorder.start(1000);
    recordedMs = 0;
    stretchStart = performance.now();
    startMeter(stream);
    timer = setInterval(tick, 250);
    setState('recording');
    renderTime();
    announce('Recording started.');
  }

  if (supported) {
    void refreshDevices();
    navigator.mediaDevices.addEventListener?.('devicechange', () => void refreshDevices());
  }

  return {
    element,
    get busy() {
      return state !== 'idle';
    },
    stop: () => finishRecording(null),
    dispose() {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.removeEventListener('stop', finish);
        try {
          mediaRecorder.stop();
        } catch {
          // already stopped
        }
      }
      mediaRecorder = null;
      pieces = [];
      release();
      if (state !== 'idle') setState('idle');
    },
  };
}
