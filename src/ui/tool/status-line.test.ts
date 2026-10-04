import { afterEach, describe, expect, it, vi } from 'vitest';
import * as announcer from '../feedback/announce';
import { PROGRESS_ANNOUNCE_MS, createStatusLine } from './status-line';

afterEach(() => vi.restoreAllMocks());

describe('createStatusLine', () => {
  it('announces every status, but progress at most once per interval', () => {
    const said = vi.spyOn(announcer, 'announce').mockImplementation(() => undefined);
    let clock = 1000;
    const line = createStatusLine(() => clock);
    expect(line.element.getAttribute('role')).toBeNull(); // not a live region itself

    line.status('Composing…');
    line.progress('Composing… 1 s');
    line.progress('Composing… 2 s');
    expect(line.element.textContent).toBe('Composing… 2 s');
    expect(said.mock.calls.map(([text]) => text)).toEqual(['Composing…']);

    clock += PROGRESS_ANNOUNCE_MS;
    line.progress('Composing… 12 s');
    line.progress('Composing… 13 s');
    expect(said.mock.calls.map(([text]) => text)).toEqual(['Composing…', 'Composing… 12 s']);

    line.status('Done');
    line.status('');
    expect(said.mock.calls).toHaveLength(3);
    expect(line.element.textContent).toBe('');
  });
});
