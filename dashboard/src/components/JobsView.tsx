import { useCallback, useEffect, useRef, useState } from 'react';
import { Ban, ChevronDown, Eraser, Inbox, RefreshCw, RotateCcw, Search, Trash2, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import type { Job, Metrics } from '../lib/api';
import { ago, count, duration, shortId } from '../lib/format';
import { useNow } from '../lib/hooks';
import type { Notify } from '../lib/hooks';
import { onJobEvent } from '../lib/live';
import { STATUS, STATUSES, patchJob, statusKey } from '../lib/status';
import type { StatusKey } from '../lib/status';
import { ConfirmDialog, Empty, ProgressBar, StatusPill } from './ui';
import type { ConfirmSpec } from './ui';

const PAGE = 25;
/** The API caps `limit` at 100 */
const MAX_WINDOW = 100;

interface Props {
  queue: string;
  metrics: Metrics;
  status: StatusKey;
  onStatus: (status: StatusKey) => void;
  onOpenJob: (queue: string, jobId: string) => void;
  notify: Notify;
  /** Called after an action changed queue state, so counters refresh at once */
  onChanged: () => void;
}

export function JobsView({ queue, metrics, status, onStatus, onOpenJob, notify, onChanged }: Props) {
  const [filter, setFilter] = useState('');
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  // Bumped after a bulk action to remount the table with a fresh load
  const [generation, setGeneration] = useState(0);

  const bulk = async (run: () => Promise<string>) => {
    try {
      notify('ok', await run());
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Action failed');
    }
    setGeneration(g => g + 1);
    onChanged();
  };

  const retryAll = () => setConfirm({
    title: 'Retry all failed jobs',
    body: `Moves all ${count(metrics.failed)} failed job(s) on "${queue}" back to waiting with a fresh attempt budget.`,
    action: 'Retry all',
    run: () => bulk(async () => {
      const n = await api.retryAll(queue);
      onStatus('waiting');
      return `Re-queued ${count(n)} job(s)`;
    }),
  });

  const clearCompleted = () => setConfirm({
    title: 'Clear old completed jobs',
    body: `Deletes completed jobs on "${queue}" that finished more than one hour ago. Newer ones are kept.`,
    action: 'Clear',
    danger: true,
    run: () => bulk(async () => `Cleared ${count(await api.clearCompleted(queue))} completed job(s)`),
  });

  const purge = () => setConfirm({
    title: 'Purge job history',
    body: `Permanently deletes every completed, failed and cancelled job on "${queue}". Waiting, delayed and active jobs are not touched. This cannot be undone.`,
    action: 'Purge history',
    danger: true,
    run: () => bulk(async () => {
      const d = await api.purgeHistory(queue);
      return `Purged ${count(d.completed + d.failed + d.cancelled)} job record(s)`;
    }),
  });

  return (
    <section className="panel overflow-hidden">
      {/* Status tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-white/[0.06] px-2 pt-2" role="tablist">
        {STATUSES.map(key => (
          <button
            key={key}
            role="tab"
            aria-selected={status === key}
            onClick={() => onStatus(key)}
            className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 pb-2.5 pt-1.5 text-xs transition-colors ${
              status === key ? 'border-atom font-medium text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS[key].fill}`} />
            {STATUS[key].label}
            <span className={`num text-[11px] ${status === key ? 'text-slate-300' : 'text-slate-600'}`}>{count(metrics[key])}</span>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-600" />
          <input
            className="field h-8 pl-8 text-xs"
            placeholder="Filter loaded rows by name or id"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            aria-label="Filter loaded rows by name or id"
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {status === 'failed' && (
            <button className="btn btn-primary" onClick={retryAll} disabled={metrics.failed === 0}>
              <RotateCcw className="h-3.5 w-3.5" /> Retry all
            </button>
          )}
          {status === 'completed' && (
            <button className="btn" onClick={clearCompleted} disabled={metrics.completed === 0}>
              <Eraser className="h-3.5 w-3.5" /> Clear older than 1h
            </button>
          )}
          <button
            className="btn btn-danger"
            onClick={purge}
            disabled={metrics.completed + metrics.failed + metrics.cancelled === 0}
          >
            <Trash2 className="h-3.5 w-3.5" /> Purge history
          </button>
        </div>
      </div>

      <JobTable
        key={`${queue}:${status}:${generation}`}
        queue={queue}
        status={status}
        filter={filter.trim().toLowerCase()}
        onOpenJob={onOpenJob}
        notify={notify}
        onChanged={onChanged}
      />

      {confirm && <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} />}
    </section>
  );
}

// ─── Table ────────────────────────────────────────────────────────────────────

const EMPTY_HINT: Record<StatusKey, string> = {
  waiting: 'Nothing is queued. New jobs land here until a worker picks them up.',
  active: 'No job is being processed right now.',
  completed: 'No completed jobs are retained for this queue.',
  failed: 'No failed jobs. Jobs land here once they run out of attempts.',
  delayed: 'No jobs are scheduled for later or waiting out a retry backoff.',
  cancelled: 'No cancelled jobs.',
};

/** What the "When" column says depends on where the job is in its lifecycle. */
function whenText(job: Job, now: number): string {
  switch (statusKey(job.status)) {
    case 'active':
      return job.startedAt ? `running ${duration(Math.max(0, now - job.startedAt))}` : 'just started';
    case 'completed':
      if (!job.completedAt) return '—';
      return job.startedAt
        ? `${ago(job.completedAt, now)} · took ${duration(job.completedAt - job.startedAt)}`
        : ago(job.completedAt, now);
    case 'failed':
      return job.failedAt ? ago(job.failedAt, now) : '—';
    case 'delayed':
      return job.runAt > now ? `runs in ${duration(job.runAt - now)}` : 'due now';
    default:
      return job.createdAt ? `queued ${ago(job.createdAt, now)}` : '—';
  }
}

interface TableProps {
  queue: string;
  status: StatusKey;
  filter: string;
  onOpenJob: (queue: string, jobId: string) => void;
  notify: Notify;
  onChanged: () => void;
}

/** One status tab's rows. Remounted (via `key`) whenever the queue or tab changes. */
function JobTable({ queue, status, filter, onOpenJob, notify, onChanged }: TableProps) {
  // null until the first load returns
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const now = useNow();

  const loadedCount = useRef(0);
  const visibleIds = useRef<Set<string>>(new Set());
  const dirty = useRef(true);
  const lastLoad = useRef(0);

  useEffect(() => {
    loadedCount.current = jobs?.length ?? 0;
    visibleIds.current = new Set((jobs ?? []).map(j => j.id));
  }, [jobs]);

  // Re-reads the first window of rows; rows loaded beyond it are kept as they are
  const reload = useCallback(async () => {
    const size = Math.min(Math.max(loadedCount.current, PAGE), MAX_WINDOW);
    try {
      const head = await api.jobs(queue, status, 0, size);
      const headIds = new Set(head.map(j => j.id));
      setJobs(prev => [...head, ...(prev ?? []).slice(size).filter(j => !headIds.has(j.id))]);
      if (loadedCount.current <= size) setHasMore(head.length === size);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [queue, status]);

  // Reload soon after a live event touched this queue, and every 5 s regardless
  useEffect(() => {
    const tick = () => {
      if (!dirty.current && Date.now() - lastLoad.current < 5000) return;
      dirty.current = false;
      lastLoad.current = Date.now();
      reload();
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => clearInterval(t);
  }, [reload]);

  // Patch rows already on screen the moment their event arrives
  useEffect(() => onJobEvent(e => {
    if (e.queueName !== queue) return;
    if (e.event !== 'job:progress') dirty.current = true;
    if (!visibleIds.current.has(e.jobId)) return;
    setJobs(prev => prev && prev.map(j => (j.id === e.jobId ? patchJob(j, e) : j)));
  }), [queue]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await api.jobs(queue, status, loadedCount.current, PAGE);
      setJobs(prev => {
        const known = new Set((prev ?? []).map(j => j.id));
        return [...(prev ?? []), ...page.filter(j => !known.has(j.id))];
      });
      setHasMore(page.length === PAGE);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Could not load more jobs');
    } finally {
      setLoadingMore(false);
    }
  };

  const act = async (job: Job, action: 'retry' | 'cancel') => {
    try {
      if (action === 'retry') await api.retry(queue, job.id);
      else await api.cancel(queue, job.id);
      notify('ok', action === 'retry' ? `Re-queued "${job.name}"` : `Cancelled "${job.name}"`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Action failed');
    }
    dirty.current = true;
    onChanged();
  };

  if (jobs === null) {
    return loadFailed
      ? <Empty icon={<TriangleAlert className="h-7 w-7" />} title="Could not load jobs" hint="The API did not answer. Retrying automatically." />
      : <div className="px-6 py-14 text-center text-xs text-slate-600">Loading…</div>;
  }

  const rows = filter
    ? jobs.filter(j => j.name.toLowerCase().includes(filter) || j.id.toLowerCase().includes(filter))
    : jobs;

  if (jobs.length === 0) {
    return <Empty icon={<Inbox className="h-7 w-7" />} title={`No ${STATUS[status].label.toLowerCase()} jobs`} hint={EMPTY_HINT[status]} />;
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead>
            <tr className="label border-b border-white/[0.06]">
              <th className="px-4 py-2.5 font-medium">Job</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">Priority</th>
              <th className="px-3 py-2.5 font-medium">Attempts</th>
              <th className="px-3 py-2.5 font-medium">When</th>
              <th className="px-3 py-2.5 font-medium">Progress</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {rows.map(job => {
              const key = statusKey(job.status);
              const cancellable = key === 'waiting' || key === 'delayed' || key === 'active';
              return (
                <tr
                  key={job.id}
                  onClick={() => onOpenJob(queue, job.id)}
                  className="cursor-pointer transition-colors hover:bg-white/[0.03]"
                >
                  <td className="max-w-[16rem] px-4 py-2.5">
                    <div className="truncate font-medium text-slate-100">{job.name}</div>
                    <div className="num text-[11px] text-slate-600" title={job.id}>…{shortId(job.id)}</div>
                  </td>
                  <td className="px-3 py-2.5"><StatusPill status={job.status} /></td>
                  <td className="px-3 py-2.5">
                    <span className={job.priority === 'high' ? 'text-amber-300' : job.priority === 'low' ? 'text-slate-600' : 'text-slate-400'}>
                      {job.priority ?? 'normal'}
                    </span>
                  </td>
                  <td className="num px-3 py-2.5 text-slate-400">{job.attempts}/{job.maxAttempts}</td>
                  <td className="num whitespace-nowrap px-3 py-2.5 text-slate-400">{whenText(job, now)}</td>
                  <td className="px-3 py-2.5"><ProgressBar value={job.progress ?? 0} status={job.status} /></td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1.5">
                      {key === 'failed' && (
                        <button
                          className="btn btn-icon h-7 w-7"
                          title="Retry job"
                          aria-label={`Retry ${job.name}`}
                          onClick={e => { e.stopPropagation(); act(job, 'retry'); }}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {cancellable && (
                        <button
                          className="btn btn-icon h-7 w-7 hover:border-rose-400/50 hover:text-rose-300"
                          title="Cancel job"
                          aria-label={`Cancel ${job.name}`}
                          onClick={e => { e.stopPropagation(); act(job, 'cancel'); }}
                        >
                          <Ban className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <div className="px-6 py-10 text-center text-xs text-slate-500">
          None of the {jobs.length} loaded rows match “{filter}”.
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-2.5 text-[11px] text-slate-600">
        <span className="num">
          {filter ? `${rows.length} of ${jobs.length} loaded rows` : `${jobs.length} row${jobs.length === 1 ? '' : 's'} loaded`}
        </span>
        {hasMore && (
          <button className="btn h-7" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <RefreshCw className="h-3 w-3 animate-spin" /> : <ChevronDown className="h-3 w-3" />}
            Load {PAGE} more
          </button>
        )}
      </div>
    </>
  );
}
