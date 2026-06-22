import { useState } from 'react';
import { ChevronRight, Cpu, Pause, Play, Radio } from 'lucide-react';
import type { FeedItem, JobEvent, Metrics, ThroughputBucket, WorkerInfo } from '../lib/api';
import { clock, count, duration, parseError, shortId } from '../lib/format';
import { useNow } from '../lib/hooks';
import { STATUS, workerHealth } from '../lib/status';
import type { StatusKey } from '../lib/status';
import { ThroughputChart } from './ThroughputChart';
import { Empty } from './ui';

interface Props {
  queue: string;
  metrics: Metrics;
  /** null while the first load for this queue is in flight */
  throughput: ThroughputBucket[] | null;
  feed: FeedItem[];
  workers: WorkerInfo[];
  onOpenStatus: (status: StatusKey) => void;
  onOpenJob: (queue: string, jobId: string) => void;
  onOpenWorkers: () => void;
}

export function Overview({ queue, metrics, throughput, feed, workers, onOpenStatus, onOpenJob, onOpenWorkers }: Props) {
  return (
    <div className="space-y-5">
      <Pipeline metrics={metrics} onOpenStatus={onOpenStatus} />

      <div className="grid gap-5 xl:grid-cols-3">
        <section className="panel xl:col-span-2">
          <div className="panel-head">
            <div>
              <h2 className="text-sm font-semibold text-white">Throughput</h2>
              <p className="text-[11px] text-slate-500">Jobs per minute, last 10 minutes</p>
            </div>
            <div className="flex items-center gap-4 text-[11px] text-slate-400">
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-emerald-400" />Completed</span>
              <span className="flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dashed border-rose-400" />Failed</span>
            </div>
          </div>
          <div className="px-3 pb-2 pt-3">
            {throughput === null
              ? <div className="flex h-48 items-center justify-center text-xs text-slate-600">Loading…</div>
              : <ThroughputChart buckets={throughput} />}
          </div>
        </section>

        <Performance metrics={metrics} />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <EventStream feed={feed} queue={queue} onOpenJob={onOpenJob} />
        <WorkerSummary workers={workers} queue={queue} onOpenWorkers={onOpenWorkers} />
      </div>
    </div>
  );
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

const FLOW: StatusKey[] = ['delayed', 'waiting', 'active'];
const OUTCOMES: StatusKey[] = ['completed', 'failed', 'cancelled'];

/** The job lifecycle left to right: delayed → waiting → active → one of three outcomes. */
function Pipeline({ metrics, onOpenStatus }: { metrics: Metrics; onOpenStatus: (status: StatusKey) => void }) {
  return (
    <section aria-label="Job pipeline" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:flex xl:items-stretch xl:gap-0">
      {FLOW.map(key => (
        <div key={key} className="contents xl:flex xl:flex-1 xl:items-stretch">
          <Stage status={key} value={metrics[key]} onClick={() => onOpenStatus(key)} />
          <div className="hidden w-7 shrink-0 items-center justify-center text-slate-700 xl:flex">
            <ChevronRight className="h-4 w-4" />
          </div>
        </div>
      ))}
      {/* Outcomes sit together: a job ends in exactly one of them */}
      <div className="contents xl:flex xl:flex-[3] xl:gap-2">
        {OUTCOMES.map(key => (
          <Stage key={key} status={key} value={metrics[key]} onClick={() => onOpenStatus(key)} />
        ))}
      </div>
    </section>
  );
}

function Stage({ status, value, onClick }: { status: StatusKey; value: number; onClick: () => void }) {
  const s = STATUS[status];
  return (
    <button
      onClick={onClick}
      title={`Show ${s.label.toLowerCase()} jobs`}
      className={`panel group min-w-0 flex-1 border-t-2 px-4 py-3.5 text-left transition-colors hover:bg-ink-850 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-atom/60 ${s.edge}`}
    >
      <div className="label flex items-center justify-between">
        {s.label}
        <ChevronRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className={`num mt-1.5 truncate text-2xl font-semibold ${value > 0 ? s.text : 'text-slate-600'}`}>
        {count(value)}
      </div>
    </button>
  );
}

// ─── Performance ──────────────────────────────────────────────────────────────

function Performance({ metrics }: { metrics: Metrics }) {
  const finished = metrics.completed + metrics.failed;
  const rate = finished > 0 ? (metrics.completed / finished) * 100 : null;
  const scale = metrics.p99 ?? 0;
  const rows: Array<{ label: string; value: number | null; bar: string }> = [
    { label: 'p50', value: metrics.p50, bar: 'bg-atom' },
    { label: 'p95', value: metrics.p95, bar: 'bg-amber-400' },
    { label: 'p99', value: metrics.p99, bar: 'bg-rose-400' },
  ];

  return (
    <section className="panel flex flex-col">
      <div className="panel-head">
        <div>
          <h2 className="text-sm font-semibold text-white">Performance</h2>
          <p className="text-[11px] text-slate-500">Over the retained job history</p>
        </div>
      </div>

      <div className="flex flex-1 flex-col justify-between gap-5 p-4">
        <div>
          <div className="label mb-1.5">Success rate</div>
          <div className="flex items-baseline gap-2">
            <span className={`num text-3xl font-semibold ${rate === null ? 'text-slate-600' : rate >= 99 ? 'text-emerald-300' : rate >= 90 ? 'text-amber-300' : 'text-rose-300'}`}>
              {rate === null ? '—' : `${rate.toFixed(rate === 100 ? 0 : 1)}%`}
            </span>
            <span className="text-[11px] text-slate-500">
              {finished > 0 ? `${count(metrics.completed)} of ${count(finished)} finished jobs` : 'no finished jobs yet'}
            </span>
          </div>
          <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            {rate !== null && (
              <>
                <div className="h-full bg-emerald-400 transition-all duration-500" style={{ width: `${rate}%` }} />
                <div className="h-full flex-1 bg-rose-400" />
              </>
            )}
          </div>
        </div>

        <div>
          <div className="label mb-2.5">Processing latency</div>
          <div className="space-y-2.5">
            {rows.map(r => (
              <div key={r.label} className="flex items-center gap-3">
                <span className="num w-7 text-[11px] text-slate-500">{r.label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${r.bar}`}
                    style={{ width: r.value !== null && scale > 0 ? `${Math.max(2, (r.value / scale) * 100)}%` : '0%' }}
                  />
                </div>
                <span className="num w-16 text-right text-xs text-slate-200">{r.value === null ? '—' : duration(r.value)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2.5 text-[11px] text-slate-600">Bars are relative to p99 · last 1,000 completed jobs</p>
        </div>
      </div>
    </section>
  );
}

// ─── Event stream ─────────────────────────────────────────────────────────────

const EVENT_TAG: Record<JobEvent['event'], { label: string; text: string }> = {
  'job:added':     { label: 'ADDED',    text: 'text-amber-300' },
  'job:active':    { label: 'ACTIVE',   text: 'text-sky-300' },
  'job:progress':  { label: 'PROGRESS', text: 'text-sky-200/70' },
  'job:completed': { label: 'DONE',     text: 'text-emerald-300' },
  'job:retrying':  { label: 'RETRY',    text: 'text-violet-300' },
  'job:failed':    { label: 'FAILED',   text: 'text-rose-300' },
  cancel:          { label: 'CANCEL',   text: 'text-slate-400' },
};

function eventDetail(e: FeedItem): string {
  if (e.event === 'job:progress' && e.progress !== undefined) return `${e.progress}%`;
  if (e.event === 'job:failed') return parseError(e.error)?.message ?? '';
  if (e.event === 'job:retrying' && e.runAt) return `next attempt ${clock(e.runAt)}`;
  return '';
}

/** Every lifecycle event from every queue, newest first. */
function EventStream({ feed, queue, onOpenJob }: { feed: FeedItem[]; queue: string; onOpenJob: Props['onOpenJob'] }) {
  // Holding a snapshot freezes the list so rows can be read and clicked under load
  const [frozen, setFrozen] = useState<FeedItem[] | null>(null);
  const rows = frozen ?? feed;

  return (
    <section className="panel flex flex-col xl:col-span-2">
      <div className="panel-head">
        <div className="flex items-center gap-2">
          <Radio className={`h-4 w-4 ${frozen ? 'text-slate-600' : 'text-atom'}`} />
          <h2 className="text-sm font-semibold text-white">Event stream</h2>
          <span className="text-[11px] text-slate-500">all queues</span>
        </div>
        <button className="btn h-7 px-2.5" onClick={() => setFrozen(frozen ? null : feed)}>
          {frozen ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          {frozen ? 'Resume' : 'Freeze'}
        </button>
      </div>

      {rows.length === 0 ? (
        <Empty
          icon={<Radio className="h-7 w-7" />}
          title="Listening for events…"
          hint="Lifecycle events appear here as jobs are added, picked up, retried and finished."
        />
      ) : (
        <ol className="max-h-80 overflow-y-auto py-1 font-mono text-[12px] leading-relaxed">
          {rows.map(e => {
            const tag = EVENT_TAG[e.event] ?? EVENT_TAG.cancel;
            return (
              <li key={e.key}>
                <button
                  onClick={() => onOpenJob(e.queueName, e.jobId)}
                  className="flex w-full items-baseline gap-3 px-4 py-[3px] text-left hover:bg-white/[0.04]"
                >
                  <span className="shrink-0 tabular-nums text-slate-600">{clock(e.at)}</span>
                  <span className={`w-16 shrink-0 font-semibold ${tag.text}`}>{tag.label}</span>
                  <span className={`w-28 shrink-0 truncate ${e.queueName === queue ? 'text-slate-300' : 'text-slate-600'}`}>{e.queueName}</span>
                  <span className="shrink-0 text-slate-400">{shortId(e.jobId)}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-600">{eventDetail(e)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ─── Workers ──────────────────────────────────────────────────────────────────

function WorkerSummary({ workers, queue, onOpenWorkers }: { workers: WorkerInfo[]; queue: string; onOpenWorkers: () => void }) {
  const now = useNow();
  const serving = workers.filter(w => w.queues.split(',').includes(queue));

  return (
    <section className="panel flex flex-col">
      <div className="panel-head">
        <div>
          <h2 className="text-sm font-semibold text-white">Workers on this queue</h2>
          <p className="text-[11px] text-slate-500">{serving.length} of {workers.length} online</p>
        </div>
        <button className="btn h-7 px-2.5" onClick={onOpenWorkers}>All workers</button>
      </div>

      {serving.length === 0 ? (
        <Empty
          icon={<Cpu className="h-7 w-7" />}
          title="No workers on this queue"
          hint="Jobs stay in waiting until a worker that serves this queue comes online."
        />
      ) : (
        <ul className="max-h-80 divide-y divide-white/[0.05] overflow-y-auto">
          {serving.map((w, i) => {
            const health = workerHealth(w, now);
            const busy = w.currentJob ? w.currentJob.split(',').length : 0;
            return (
              <li key={w.id ?? `${w.host}:${w.pid}:${i}`} className="flex items-center gap-3 px-4 py-2.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${health.dot}`} title={health.label} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-slate-200">{w.host}</div>
                  <div className="num text-[11px] text-slate-500">pid {w.pid} · {count(Number(w.jobsProcessed) || 0)} done</div>
                </div>
                <span className="num shrink-0 text-[11px] text-slate-400" title="Busy slots / concurrency">
                  {busy}/{w.concurrency || '1'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
