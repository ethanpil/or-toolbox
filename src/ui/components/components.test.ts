import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord, KeyInfo } from '../../core/types';
import { ApiError, NoKeyError } from '../../core/errors';
import { replace } from '../dom';
import { wasPresented } from '../feedback/errors';
import { costBadge } from './cost-badge';
import { dropZone } from './drop-zone';
import { emptyState } from './empty-state';
import { exportMenu } from './export-menu';
import { jobList } from './job-list';
import { keyPicker } from './key-picker';
import { outputPanel, stableBoundary } from './output-panel';

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, testId: string): T | null =>
  root.querySelector<T>(`[data-testid="${testId}"]`);

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('emptyState', () => {
  it('renders a title, text and action, centred or inline', () => {
    const block = emptyState({
      icon: 'star',
      title: 'Nothing',
      text: 'Yet',
      action: 'Act',
      testId: 'e',
    });
    expect(block.textContent).toBe('NothingYetAct');
    expect(block.classList.contains('text-center')).toBe(true);
    const inline = emptyState({ icon: 'star', title: 'Nothing', inline: true });
    expect(inline.classList.contains('or-empty-inline')).toBe(true);
  });
});

describe('costBadge', () => {
  it('shows Unknown, Free or an estimate, with a hidden label', () => {
    const badge = costBadge();
    expect(badge.element.textContent).toBe('Estimated cost: Unknown');
    expect(badge.element.dataset.state).toBe('unknown');
    badge.set(0);
    expect(badge.element.textContent).toContain('Free');
    expect(badge.element.dataset.state).toBe('free');
    badge.set(0.0012, 'for 1,000 output tokens');
    expect(badge.element.textContent).toContain('≈ $0.0012');
    expect(badge.element.title).toBe('for 1,000 output tokens');
  });
});

describe('dropZone', () => {
  const pick = (zone: HTMLElement, files: File[]): void => {
    const input = zone.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change'));
  };

  it('hands over accepted files and reports the rest', () => {
    const onFiles = vi.fn();
    const onReject = vi.fn();
    const zone = dropZone({ accept: ['image/*'], multiple: true, onFiles, onReject });
    document.body.append(zone);
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const txt = new File(['x'], 'b.txt', { type: 'text/plain' });
    pick(zone, [png, txt]);
    expect(onFiles).toHaveBeenCalledWith([png]);
    expect(onReject).toHaveBeenCalledWith([txt]);
  });

  it('takes a single file unless multiple', () => {
    const onFiles = vi.fn();
    const zone = dropZone({ onFiles });
    pick(zone, [new File(['1'], 'one.bin'), new File(['2'], 'two.bin')]);
    expect(onFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'one.bin' })]);
  });

  it('has a real button and describes what it accepts', () => {
    const zone = dropZone({ accept: ['application/pdf'], onFiles: vi.fn() });
    document.body.append(zone);
    const button = $<HTMLButtonElement>(zone, 'drop-zone-button')!;
    expect(button.tagName).toBe('BUTTON');
    const described = button
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['Drop a file here', 'PDF']);
    const input = zone.querySelector('input[type=file]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    button.click();
    expect(click).toHaveBeenCalledOnce();
  });

  it('keeps focus on its button when a tool rebuilds it (default focus key, overridable)', () => {
    const slot = document.createElement('div');
    document.body.append(slot);
    replace(slot, dropZone({ onFiles: vi.fn() }));
    $<HTMLButtonElement>(slot, 'drop-zone-button')!.focus();
    replace(slot, dropZone({ multiple: true, onFiles: vi.fn() }));
    expect(document.activeElement).toBe($(slot, 'drop-zone-button'));
    const custom = dropZone({ focusKey: 'reference-drop', onFiles: vi.fn() });
    expect($(custom, 'drop-zone-button')?.getAttribute('data-focus-key')).toBe('reference-drop');
  });

  it('highlights while files are dragged over it', () => {
    const zone = dropZone({ onFiles: vi.fn() });
    const drag = (type: string): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [] } });
      zone.dispatchEvent(event);
    };
    drag('dragenter');
    expect(zone.classList.contains('is-dragover')).toBe(true);
    drag('dragleave');
    expect(zone.classList.contains('is-dragover')).toBe(false);
  });
});

describe('outputPanel', () => {
  it('streams plain text after a skeleton and enables the actions when done', async () => {
    const panel = outputPanel({ format: 'text' });
    document.body.append(panel.element);
    expect($(panel.element, 'output-empty')).not.toBeNull();
    expect($<HTMLButtonElement>(panel.element, 'output-copy')!.disabled).toBe(true);

    panel.start();
    expect($(panel.element, 'output-skeleton')).not.toBeNull();
    expect($(panel.element, 'output-content')!.getAttribute('aria-busy')).toBe('true');
    expect($(panel.element, 'output-status')!.textContent).toBe('Generating…');

    panel.append('Hello ');
    panel.append('world');
    panel.finish();
    await vi.waitFor(() =>
      expect($(panel.element, 'output-content')!.textContent).toBe('Hello world'),
    );
    expect(panel.text()).toBe('Hello world');
    expect($(panel.element, 'output-status')!.textContent).toBe('Done · 2 words');
    expect($(panel.element, 'output-content')!.getAttribute('aria-busy')).toBe('false');
    expect($<HTMLButtonElement>(panel.element, 'output-copy')!.disabled).toBe(false);
  });

  it('renders Markdown safely', async () => {
    const panel = outputPanel({ format: 'markdown' });
    panel.start();
    panel.setText('# Title\n\n<img src=x onerror=alert(1)>**bold**');
    panel.finish();
    const content = $(panel.element, 'output-content')!;
    await vi.waitFor(() => expect(content.querySelector('h1')?.textContent).toBe('Title'));
    expect(content.querySelector('strong')?.textContent).toBe('bold');
    expect(content.querySelector('[onerror]')).toBeNull();
  });

  it('keeps partial text and shows the error after a failure', async () => {
    const panel = outputPanel({ format: 'text' });
    panel.start();
    panel.append('Partial');
    panel.fail('The model stopped.');
    await vi.waitFor(() =>
      expect($(panel.element, 'output-error')?.textContent).toBe('The model stopped.'),
    );
    expect($(panel.element, 'output-content')!.textContent).toContain('Partial');
  });

  it('renders completed blocks once while streaming and keeps up with every chunk', async () => {
    const panel = outputPanel({ format: 'markdown' });
    document.body.append(panel.element);
    panel.start();
    panel.append('# Title\n\nFirst paragraph.\n\n');
    const content = $(panel.element, 'output-content')!;
    await vi.waitFor(() => expect(content.querySelector('h1')?.textContent).toBe('Title'));
    const heading = content.querySelector('h1');
    for (let i = 0; i < 20; i++) panel.append(`word${i} `);
    // The stable block is not re-rendered: the very same <h1> node stays.
    await vi.waitFor(() => expect(content.textContent).toContain('word19'));
    expect(content.querySelector('h1')).toBe(heading);
    panel.finish();
    await vi.waitFor(() => expect(content.querySelector('.or-caret')).toBeNull());
    expect(content.textContent).toContain('First paragraph.');
    expect(content.textContent).toContain('word0 word1');
  });

  it('stays silent about a Stop and keeps the partial text', async () => {
    const panel = outputPanel({ format: 'text' });
    panel.start();
    panel.append('Half');
    panel.fail(new DOMException('Stopped by the user.', 'AbortError'));
    await vi.waitFor(() => expect($(panel.element, 'output-content')!.textContent).toBe('Half'));
    expect($(panel.element, 'output-error')).toBeNull();
    expect($(panel.element, 'output-status')!.textContent).toBe(
      'Stopped. The partial result is kept.',
    );
  });

  it('leaves errors that need an action to presentError, and shows the rest once', async () => {
    const panel = outputPanel({ format: 'text' });
    panel.start();
    const noKey = new NoKeyError();
    panel.fail(noKey);
    await vi.waitFor(() => expect($(panel.element, 'output-status')!.textContent).toBe('Not run.'));
    expect($(panel.element, 'output-error')).toBeNull();
    expect(wasPresented(noKey)).toBe(false);

    panel.start();
    const failure = new ApiError('The provider is overloaded.', 503);
    panel.fail(failure);
    await vi.waitFor(() =>
      expect($(panel.element, 'output-error')?.textContent).toBe('The provider is overloaded.'),
    );
    expect(wasPresented(failure)).toBe(true);
  });

  it('words an error that may have been billed with the caution and a link to the activity page', async () => {
    const panel = outputPanel({ format: 'text' });
    panel.start();
    const unknown = Object.assign(new ApiError('Bad gateway', 502), { outcomeUnknown: true });
    panel.fail(unknown);
    await vi.waitFor(() =>
      expect($(panel.element, 'output-error')?.textContent).toMatch(
        /check your OpenRouter activity before sending it again/,
      ),
    );
    expect($<HTMLAnchorElement>(panel.element, 'output-activity')?.getAttribute('href')).toBe(
      'https://openrouter.ai/activity',
    );
    expect(wasPresented(unknown)).toBe(true);
  });

  it('announces its status once, through the announcer only (the line is not a live region)', () => {
    const panel = outputPanel({ format: 'text' });
    expect($(panel.element, 'output-status')!.getAttribute('role')).toBeNull();
  });

  it('offers Send to… with the text', () => {
    const sendTo = vi.fn();
    const panel = outputPanel({ format: 'markdown', sendTo, filename: 'answer' });
    panel.start();
    panel.setText('Done');
    panel.finish();
    $<HTMLButtonElement>(panel.element, 'output-send')!.click();
    expect(sendTo).toHaveBeenCalledWith([
      { kind: 'text', text: 'Done', type: 'text/markdown', name: 'answer.md' },
    ]);
  });
});

describe('stableBoundary', () => {
  it('ends after the last blank line outside a code fence', () => {
    expect(stableBoundary('a\n\nb', 0)).toBe(3);
    expect(stableBoundary('a\n\nb\n\nc', 0)).toBe(6);
    expect(stableBoundary('no blank line yet', 0)).toBe(0);
    // A blank line inside an open fence is not a boundary.
    expect(stableBoundary('p\n\n```\ncode\n\nmore', 0)).toBe(3);
    expect(stableBoundary('```\ncode\n\n```\n\nafter', 0)).toBe(15);
    // Scanning resumes from the previous boundary.
    expect(stableBoundary('a\n\nb\n\nc', 3)).toBe(6);
  });
});

describe('exportMenu', () => {
  it('builds the file only when chosen and saves it with the right name', async () => {
    const created: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob as Blob);
      return 'blob:test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    const build = vi.fn(() => new Blob(['csv'], { type: 'text/csv' }));
    const menu = exportMenu({
      filename: () => 'table',
      formats: [
        { label: 'CSV', extension: 'csv', build },
        { label: 'JSON', extension: 'json', build: () => new Blob(['{}']) },
      ],
    });
    document.body.append(menu);
    expect(build).not.toHaveBeenCalled();
    $<HTMLButtonElement>(menu, 'export-csv')!.click();
    await vi.waitFor(() => expect(names).toEqual(['table.csv']));
    expect(build).toHaveBeenCalledOnce();
    expect(await created[0]!.text()).toBe('csv');
  });

  it('is a single button for one format', () => {
    const menu = exportMenu({
      filename: 'x',
      formats: [{ label: 'Text', extension: 'txt', build: () => new Blob([]) }],
    });
    expect($(menu, 'export-menu')?.tagName).toBe('BUTTON');
    expect(menu.textContent).toBe('Download .txt');
  });

  it('updates in place, so an open menu stays open', async () => {
    const format = (extension: string) => ({
      label: extension.toUpperCase(),
      extension,
      build: () => new Blob([extension]),
    });
    const menu = exportMenu({ filename: 'x', formats: [format('csv'), format('json')] });
    document.body.append(menu);
    const toggle = $<HTMLButtonElement>(menu, 'export-menu')!;
    const list = menu.querySelector('.dropdown-menu')!;
    toggle.click();
    await vi.waitFor(() => expect(list.classList.contains('show')).toBe(true));
    $<HTMLButtonElement>(menu, 'export-json')!.focus();

    menu.update([format('csv'), format('json'), format('xlsx')]);
    expect($(menu, 'export-menu')).toBe(toggle);
    expect(menu.querySelector('.dropdown-menu')).toBe(list);
    expect(list.classList.contains('show')).toBe(true);
    expect([...list.querySelectorAll('.dropdown-item')].map((item) => item.textContent)).toEqual([
      'CSV.csv',
      'JSON.json',
      'XLSX.xlsx',
    ]);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('export-json');

    menu.update({ disabled: true });
    expect(toggle.disabled).toBe(true);
    await vi.waitFor(() => expect(list.classList.contains('show')).toBe(false));

    menu.update({ formats: [format('txt')], disabled: false });
    expect($(menu, 'export-menu')?.textContent).toBe('Download .txt');
    expect($<HTMLButtonElement>(menu, 'export-menu')!.disabled).toBe(false);
  });
});

describe('keyPicker', () => {
  const key = (id: string, name: string, isDefault = false): KeyInfo => ({
    id,
    name,
    colour: id === 'a' ? '#ff0000' : null,
    masked: `sk-or-…${id}${id}${id}${id}`,
    source: 'pasted',
    createdAt: 0,
    noRetention: false,
    isDefault,
  });

  it('shows the default key until one is pinned, and reports choices', () => {
    const onChange = vi.fn();
    const keys = [key('a', 'Work', true), key('b', 'Sandbox')];
    const picker = keyPicker({ keys, value: undefined, onChange });
    expect($(picker, 'key-picker')!.getAttribute('aria-label')).toBe('Key: Work (default)');
    $<HTMLButtonElement>(picker, 'key-option-b')!.click();
    expect(onChange).toHaveBeenCalledWith('b');
    $<HTMLButtonElement>(picker, 'key-option-default')!.click();
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    const pinned = keyPicker({ keys, value: 'b', onChange });
    expect($(pinned, 'key-picker')!.getAttribute('aria-label')).toBe('Key: Sandbox');
    expect($(pinned, 'key-option-b')!.getAttribute('aria-current')).toBe('true');
  });
});

describe('jobList', () => {
  const job = (patch: Partial<JobRecord>): JobRecord => ({
    id: 'j1',
    tool: 'video-studio',
    type: 'video',
    state: 'running',
    runId: null,
    keyId: 'k',
    remoteId: 'remote-1',
    groupId: null,
    payload: {},
    result: null,
    progress: null,
    remoteStatus: 'in_progress',
    error: null,
    failureKind: null,
    createdAt: 0,
    updatedAt: Date.now(),
    attempts: 0,
    ...patch,
  });

  it('shows progress for running jobs and a cancel button', () => {
    const onCancel = vi.fn();
    const list = jobList({ label: () => 'Clip 1', onCancel });
    list.update([job({ progress: 0.42 })]);
    const bar = list.element.querySelector('[role=progressbar]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    list.element.querySelector<HTMLButtonElement>('[aria-label="Cancel Clip 1"]')!.click();
    expect(onCancel).toHaveBeenCalledOnce();

    list.update([job({ progress: null })]);
    expect(list.element.querySelector('[role=progressbar]')!.getAttribute('aria-valuetext')).toBe(
      'in_progress',
    );
    expect(list.element.querySelector('.progress-bar-animated')).not.toBeNull();
  });

  it('names the button after what it does when the tool says so', () => {
    const list = jobList({
      label: () => 'Clip 1',
      onCancel: () => undefined,
      cancelLabel: 'Stop waiting',
    });
    list.update([job({ progress: 0.1 })]);
    expect(list.element.querySelector('[aria-label="Stop waiting for Clip 1"]')).not.toBeNull();
    expect(list.element.querySelector('[aria-label="Cancel Clip 1"]')).toBeNull();
  });

  it('shows final states without progress, and an empty state', () => {
    const list = jobList();
    list.update([job({ state: 'failed', error: 'Provider error' })]);
    expect(list.element.textContent).toContain('Failed');
    expect(list.element.textContent).toContain('Provider error');
    expect(list.element.querySelector('[role=progressbar]')).toBeNull();
    list.update([]);
    expect(list.element.textContent).toContain('No jobs');
  });
});
