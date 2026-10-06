/**
 * `jobList()`: persistent jobs (video generation, batches) as a list with state badges and progress bars
 * (striped and animated while a job runs without a known percentage). `bindJobList()` keeps one in step with
 * the jobs service, including changes from other tabs.
 *
 * ```ts
 * const list = jobList({ label: (job) => job.payload.prompt, onCancel: (job) => ctx.jobs.cancel(job.id) });
 * ctx.ui.output.append(list.element);
 * bindJobList(ctx.jobs, list, { tool: ctx.manifest.id });
 * ```
 */
import type { JobRecord, JobsService, JobState, ToolId } from '../../core/types';
import { h, replace } from '../dom';
import { formatRelativeTime } from '../format';
import { icon } from '../icon';
import { emptyState } from './empty-state';

export interface JobListOptions {
  /** The job's display name; default its type and remote id. */
  label?: (job: JobRecord) => string;
  /** Shows a button on unfinished jobs that calls this. */
  onCancel?: (job: JobRecord) => void;
  /** What that button does, for its accessible name (`<label> for <job>`); without it, `Cancel <job>`. */
  cancelLabel?: string;
  emptyText?: string;
  testId?: string;
}

export interface JobList {
  readonly element: HTMLElement;
  update(jobs: readonly JobRecord[]): void;
}

const STATE_BADGES: Record<JobState, [label: string, className: string]> = {
  queued: ['Queued', 'text-bg-secondary'],
  running: ['Running', 'text-bg-primary'],
  succeeded: ['Done', 'text-bg-success'],
  failed: ['Failed', 'text-bg-danger'],
  cancelled: ['Canceled', 'text-bg-secondary'],
};

const isFinal = (state: JobState): boolean =>
  state === 'succeeded' || state === 'failed' || state === 'cancelled';

export function jobList(options: JobListOptions = {}): JobList {
  const element = h('div', { class: 'or-job-list', 'data-testid': options.testId ?? 'job-list' });

  const row = (job: JobRecord): HTMLElement => {
    const [badge, badgeClass] = STATE_BADGES[job.state];
    const name = options.label?.(job) ?? `${job.type}${job.remoteId ? ` ${job.remoteId}` : ''}`;
    const percent =
      job.progress !== null ? Math.round(Math.min(1, Math.max(0, job.progress)) * 100) : null;
    const running = !isFinal(job.state);
    // "Cancel Clip 1", or with a label of the tool's own "Stop waiting for Clip 1".
    const cancel = options.cancelLabel ? `${options.cancelLabel} for ${name}` : `Cancel ${name}`;
    return h(
      'li',
      { class: 'list-group-item py-3', 'data-testid': `job-${job.id}` },
      h(
        'div',
        { class: 'd-flex align-items-center gap-2 mb-2' },
        h('span', { class: 'fw-semibold text-truncate flex-grow-1' }, name),
        h('span', { class: `badge rounded-pill ${badgeClass}` }, badge),
        running && options.onCancel
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-sm btn-outline-secondary',
                'aria-label': cancel,
                'data-focus-key': `cancel:${job.id}`,
                onclick: () => options.onCancel?.(job),
              },
              icon('x-lg'),
            )
          : null,
      ),
      running
        ? h(
            'div',
            {
              class: 'progress',
              role: 'progressbar',
              'aria-label': `${name} progress`,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              ...(percent !== null
                ? { 'aria-valuenow': percent }
                : { 'aria-valuetext': job.remoteStatus ?? 'In progress' }),
            },
            h('div', {
              class: [
                'progress-bar',
                percent === null && 'progress-bar-striped progress-bar-animated',
              ],
              style: { width: `${percent ?? 100}%` },
            }),
          )
        : null,
      h(
        'div',
        { class: 'small text-body-secondary mt-1' },
        job.state === 'failed' && job.error
          ? h('span', { class: 'text-danger-emphasis' }, job.error)
          : (job.remoteStatus ?? ''),
        job.remoteStatus || job.error ? ' · ' : '',
        `updated ${formatRelativeTime(job.updatedAt)}`,
      ),
    );
  };

  const update = (jobs: readonly JobRecord[]): void => {
    if (jobs.length === 0) {
      replace(
        element,
        emptyState({
          icon: 'hourglass',
          title: 'No jobs',
          text: options.emptyText ?? 'Long-running work appears here.',
          compact: true,
        }),
      );
      return;
    }
    replace(element, h('ul', { class: 'list-group' }, jobs.map(row)));
  };
  update([]);
  return { element, update };
}

/** Fills `list` from the jobs service and keeps it current; returns an unsubscribe function. */
export function bindJobList(
  jobs: JobsService,
  list: JobList,
  filter: { tool?: ToolId; groupId?: string; states?: JobState[] } = {},
): () => void {
  let generation = 0;
  const refresh = (): void => {
    const mine = ++generation;
    void jobs
      .list(filter)
      .then((records) => {
        if (mine === generation)
          list.update([...records].sort((a, b) => b.createdAt - a.createdAt));
      })
      .catch(() => undefined);
  };
  refresh();
  return jobs.subscribe(refresh);
}
