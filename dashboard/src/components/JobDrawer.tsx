import { useCallback, useEffect, useState } from 'react';
import { Ban, Check, Copy, RotateCcw, X } from 'lucide-react';
import { api } from '../lib/api';
import type { Job } from '../lib/api';
import { dateTime, duration, parseError } from '../lib/format';
import { useEscape, usePolling } from '../lib/hooks';
import type { Notify } from '../lib/hooks';
import { onJobEvent } from '../lib/live';
import { STATUS, patchJob, statusKey } from '../lib/status';
import { StatusPill } from './ui';

interface Props {
  queue: string;
  jobId: string;
  onClose: () => void;
  notify: Notify;
  onChanged: () => void;
}

/** Slide-over inspector for one job. Stays live while it is open. */
export function JobDrawer({ queue, jobId, onClose, notify, onChanged }: Props) {
  const [job, setJob] = useState<Job | null>(null);
  // The job hash is gone (pruned by cleanup), or the request failed
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState(false);
  useEscape(onClose);

  const load = useCallback(async () => {
    try {
      const fresh = await api.job(queue, jobId);
      setJob(fresh);
      setMissing(false);
    } catch {
      setMissing(true);
    }
  }, [queue, jobId]);

  usePolling(load, 2500);

  useEffect(() => onJobEvent(e => {
    if (e.jobId !== jobId || e.queueName !== queue) return;
    setJob(prev => prev && patchJob(prev, e));
    // Timestamps and attempt counts only come from the server
    if (e.event !== 'job:progress') load();
  }), [jobId, queue, load]);

  const act = async (action: 'retry' | 'cancel') => {
    try {
      if (action === 'retry') await api.retry(queue, jobId);
      else await api.cancel(queue, jobId);
      notify('ok', action === 'retry' ? 'Job re-queued' : 'Job cancelled');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Action failed');
    }
    load();
    onChanged();
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(jobId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      notify('error', 'Clipboard is not available');
    }
  };

  const key = statusKey(job?.status);
  const error = parseError(job?.error);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 animate-fade-in bg-black/60" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Job details"
        className="relative flex h-full w-full max-w-xl animate-slide-in flex-col border-l border-white/10 bg-ink-850 shadow-2xl shadow-black/70"
      >
        {/* Header */}
        <div className="shrink-0 border-b border-white/[0.07] px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="label mb-1 font-mono normal-case tracking-normal">{queue}</div>
              <h2 className="truncate text-lg font-semibold text-white">{job?.name ?? (missing ? 'Job not found' : 'Loading…')}</h2>
            </div>
            <button className="btn btn-icon shrink-0" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {job && <StatusPill status={job.status} />}
            <button
              onClick={copyId}
              title="Copy job id"
              className="num flex min-w-0 items-center gap-1.5 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-slate-400 hover:border-white/20 hover:text-slate-200"
            >
              <span className="truncate">{jobId}</span>
              {copied ? <Check className="h-3 w-3 shrink-0 text-atom" /> : <Copy className="h-3 w-3 shrink-0" />}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {!job ? (
            <p className="text-sm text-slate-500">
              {missing
                ? 'This job no longer exists. Finished jobs are removed by the cleanup policy once they age out.'
                : 'Loading job…'}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Fact label="Priority" value={job.priority ?? 'normal'} />
                <Fact label="Attempts" value={`${job.attempts} of ${job.maxAttempts}`} />
                <Fact
                  label="Retry backoff"
                  value={job.backoff ? `${job.backoff.type} · ${duration(job.backoff.delay)}` : '1s fixed'}
                />
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="label">Progress</span>
                  <span className="num text-xs text-slate-300">{Math.round(job.progress ?? 0)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${STATUS[key].fill}`}
                    style={{ width: `${Math.max(0, Math.min(100, job.progress ?? 0))}%` }}
                  />
                </div>
              </div>

              <Timeline job={job} />

              {error && (
                <div>
                  <div className="label mb-2 text-rose-400/80">Error</div>
                  <div className="rounded-lg border border-rose-400/25 bg-rose-400/[0.06] p-3">
                    <p className="break-words font-mono text-xs text-rose-200">{error.message}</p>
                    {error.stack && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11px] text-rose-300/70 hover:text-rose-200">Stack trace</summary>
                        <pre className="mt-2 overflow-x-auto whitespace-pre text-[11px] leading-relaxed text-rose-200/70">{error.stack}</pre>
                      </details>
                    )}
                  </div>
                </div>
              )}

              <div>
                <div className="label mb-2">Payload</div>
                <pre className="max-h-80 overflow-auto rounded-lg border border-white/[0.07] bg-ink-950 p-3 font-mono text-xs leading-relaxed text-slate-300">
                  {JSON.stringify(job.data, null, 2) ?? 'undefined'}
                </pre>
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        {job && (key === 'failed' || key === 'waiting' || key === 'delayed' || key === 'active') && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-white/[0.07] px-5 py-3">
            {key === 'failed' ? (
              <button className="btn btn-primary" onClick={() => act('retry')}>
                <RotateCcw className="h-3.5 w-3.5" /> Retry job
              </button>
            ) : (
              <button className="btn btn-danger" onClick={() => act('cancel')}>
                <Ban className="h-3.5 w-3.5" /> Cancel job
              </button>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
      <div className="label">{label}</div>
      <div className="mt-1 truncate text-xs font-medium text-slate-200" title={value}>{value}</div>
    </div>
  );
}

interface Step {
  label: string;
  at: number;
  note?: string;
  fill: string;
}

/** The timestamps the server recorded for this job, oldest first. */
function Timeline({ job }: { job: Job }) {
  const steps: Step[] = [];
  if (job.createdAt) steps.push({ label: 'Created', at: job.createdAt, fill: 'bg-slate-500' });
  // runAt moves on every retry, so it only means "scheduled" while the job is parked
  if (statusKey(job.status) === 'delayed') {
    steps.push({ label: job.attempts > 0 ? 'Next attempt' : 'Scheduled for', at: job.runAt, fill: STATUS.delayed.fill });
  }
  if (job.startedAt) {
    steps.push({
      label: job.attempts > 0 ? 'Last started' : 'Started',
      at: job.startedAt,
      note: job.createdAt ? `${duration(job.startedAt - job.createdAt)} after creation` : undefined,
      fill: STATUS.active.fill,
    });
  }
  if (job.completedAt) {
    steps.push({
      label: 'Completed',
      at: job.completedAt,
      note: job.startedAt ? `ran for ${duration(job.completedAt - job.startedAt)}` : undefined,
      fill: STATUS.completed.fill,
    });
  }
  if (job.failedAt) {
    steps.push({
      label: 'Failed',
      at: job.failedAt,
      note: job.startedAt ? `ran for ${duration(job.failedAt - job.startedAt)}` : undefined,
      fill: STATUS.failed.fill,
    });
  }
  steps.sort((a, b) => a.at - b.at);

  return (
    <div>
      <div className="label mb-3">Timeline</div>
      <ol className="space-y-3.5 border-l border-white/10 pl-4">
        {steps.map(step => (
          <li key={step.label} className="relative">
            <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-ink-850 ${step.fill}`} />
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-medium text-slate-200">{step.label}</span>
              <span className="num shrink-0 text-[11px] text-slate-500">{dateTime(step.at)}</span>
            </div>
            {step.note && <div className="mt-0.5 text-[11px] text-slate-500">{step.note}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}
