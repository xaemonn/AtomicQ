import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu, Pause, Play, Plus, RefreshCw, ServerCrash } from 'lucide-react';
import { api } from './lib/api';
import type { FeedItem, Health, JobEvent, Metrics, ThroughputBucket, WorkerInfo } from './lib/api';
import { usePolling, useToasts } from './lib/hooks';
import { onJobEvent, useConnected } from './lib/live';
import { EMPTY_METRICS, applyEvents } from './lib/status';
import type { StatusKey } from './lib/status';
import { AddJobDialog } from './components/AddJobDialog';
import { JobDrawer } from './components/JobDrawer';
import { JobsView } from './components/JobsView';
import { Overview } from './components/Overview';
import { SchedulesView } from './components/SchedulesView';
import { Sidebar } from './components/Sidebar';
import type { View } from './components/Sidebar';
import { AtomLogo, ToastStack } from './components/ui';
import { WorkersView } from './components/WorkersView';

const POLL_MS = 5000;
const THROUGHPUT_POLL_MS = 30_000;
/** Live events are applied in batches so a burst costs one render, not thousands */
const FLUSH_MS = 250;
const FEED_MAX = 80;

const VIEW_TITLE: Record<View, string> = {
  overview: 'Overview',
  jobs: 'Jobs',
  workers: 'Workers',
  schedules: 'Schedules',
};

export default function App() {
  // 'loading' → first request in flight; 'down' → API unreachable, retrying
  const [boot, setBoot] = useState<'loading' | 'ready' | 'down'>('loading');
  const [queues, setQueues] = useState<string[]>([]);
  const [queue, setQueue] = useState('');
  const [view, setView] = useState<View>('overview');
  const [jobStatus, setJobStatus] = useState<StatusKey>('waiting');
  const [navOpen, setNavOpen] = useState(false);

  const [metrics, setMetrics] = useState<Record<string, Metrics>>({});
  const [paused, setPaused] = useState<Record<string, boolean>>({});
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [throughput, setThroughput] = useState<{ queue: string; buckets: ThroughputBucket[] } | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);

  const [openJob, setOpenJob] = useState<{ queue: string; id: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const { toasts, notify, dismiss } = useToasts();
  const connected = useConnected();

  // ── Boot: discover the queues, retrying while the API is unreachable ───────
  const loadQueues = useCallback(async () => {
    try {
      const names = await api.queues();
      setQueues(names);
      setQueue(current => current || names[0] || '');
      setBoot('ready');
    } catch {
      setBoot('down');
    }
  }, []);

  usePolling(loadQueues, 3000, boot !== 'ready');

  // ── Polling: counters, pause flags, workers and health for every queue ─────
  const refresh = useCallback(async () => {
    if (queues.length === 0) return;
    try {
      const [allMetrics, allPaused, workerList, healthNow] = await Promise.all([
        Promise.all(queues.map(name => api.metrics(name))),
        Promise.all(queues.map(name => api.isPaused(name))),
        api.workers(),
        api.health(),
      ]);
      setMetrics(Object.fromEntries(queues.map((name, i) => [name, allMetrics[i]])));
      setPaused(Object.fromEntries(queues.map((name, i) => [name, allPaused[i]])));
      setWorkers(workerList);
      setHealth(healthNow);
      setStale(false);
    } catch {
      setStale(true);
    }
  }, [queues]);

  usePolling(refresh, POLL_MS);

  const loadThroughput = useCallback(async () => {
    if (!queue) return;
    try {
      const buckets = await api.throughput(queue);
      setThroughput({ queue, buckets });
    } catch {
      // Transient — keep showing the last buckets until the next refresh
    }
  }, [queue]);

  usePolling(loadThroughput, THROUGHPUT_POLL_MS);

  // ── Live events: buffer as they arrive, apply in batches ───────────────────
  const buffer = useRef<JobEvent[]>([]);
  const feedSeq = useRef(0);

  useEffect(() => onJobEvent(e => { buffer.current.push(e); }), []);

  useEffect(() => {
    const t = setInterval(() => {
      const batch = buffer.current;
      if (batch.length === 0) return;
      buffer.current = [];

      setMetrics(prev => applyEvents(prev, batch));

      const at = Date.now();
      const items: FeedItem[] = batch.slice(-FEED_MAX).reverse().map(e => ({ ...e, key: ++feedSeq.current, at }));
      setFeed(prev => [...items, ...prev].slice(0, FEED_MAX));

      // Count finished jobs into the current (last) throughput bucket
      setThroughput(prev => {
        if (!prev || prev.buckets.length === 0) return prev;
        let completed = 0;
        let failed = 0;
        for (const e of batch) {
          if (e.queueName !== prev.queue) continue;
          if (e.event === 'job:completed') completed++;
          else if (e.event === 'job:failed') failed++;
        }
        if (completed === 0 && failed === 0) return prev;
        const buckets = [...prev.buckets];
        const last = buckets[buckets.length - 1];
        buckets[buckets.length - 1] = { ...last, completed: last.completed + completed, failed: last.failed + failed };
        return { ...prev, buckets };
      });
    }, FLUSH_MS);
    return () => clearInterval(t);
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────────
  const refreshNow = async () => {
    setRefreshing(true);
    await Promise.all([refresh(), loadThroughput()]);
    setRefreshing(false);
  };

  const togglePause = async () => {
    const wasPaused = paused[queue] ?? false;
    try {
      if (wasPaused) await api.resume(queue);
      else await api.pause(queue);
      setPaused(prev => ({ ...prev, [queue]: !wasPaused }));
      notify('ok', wasPaused ? `Resumed ${queue}` : `Paused ${queue} — workers stop picking up new jobs`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Could not change the pause state');
    }
  };

  const showJob = useCallback((jobQueue: string, id: string) => setOpenJob({ queue: jobQueue, id }), []);

  // ── Screens before the API has answered ────────────────────────────────────
  if (boot !== 'ready') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="panel w-full max-w-md px-8 py-10 text-center">
          {boot === 'loading' ? (
            <>
              <AtomLogo className="mx-auto h-12 w-12 animate-orbit text-atom" />
              <p className="mt-5 text-sm text-slate-400">Connecting to AtomicQ…</p>
            </>
          ) : (
            <>
              <ServerCrash className="mx-auto h-10 w-10 text-rose-400" />
              <h1 className="mt-4 text-base font-semibold text-white">Can’t reach the AtomicQ API</h1>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                Start the server with <code className="font-mono text-slate-300">npm run dev</code> in the project root
                (it listens on port 3000) and make sure Redis is running.
              </p>
              <p className="mt-4 flex items-center justify-center gap-2 text-[11px] text-slate-600">
                <RefreshCw className="h-3 w-3 animate-spin" /> Retrying every 3 seconds
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!queue) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="panel w-full max-w-md px-8 py-10 text-center">
          <AtomLogo className="mx-auto h-10 w-10 text-slate-600" />
          <h1 className="mt-4 text-base font-semibold text-white">No queues registered</h1>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            The server is up but exposes no queues. Register them in <code className="font-mono text-slate-300">src/server.ts</code>.
          </p>
        </div>
      </div>
    );
  }

  const current = metrics[queue] ?? EMPTY_METRICS;
  const isPaused = paused[queue] ?? false;

  return (
    <div className="flex h-full">
      <Sidebar
        view={view}
        onView={setView}
        queues={queues}
        queue={queue}
        onQueue={setQueue}
        metrics={metrics}
        paused={paused}
        connected={connected}
        health={health}
        workerCount={workers.length}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.07] bg-ink-950/60 px-4 backdrop-blur lg:px-7">
          <button className="btn btn-icon lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Menu className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <div className="label leading-none">{VIEW_TITLE[view]}</div>
            <h1 className="mt-1 truncate font-mono text-sm font-medium leading-none text-white">
              {view === 'workers' ? 'all queues' : queue}
            </h1>
          </div>
          {isPaused && view !== 'workers' && (
            <span className="hidden items-center gap-1.5 rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-300 sm:flex">
              <Pause className="h-3 w-3" /> Paused
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            {stale && (
              <span className="hidden text-[11px] text-rose-300 md:inline" role="status">API not responding — showing last known data</span>
            )}
            {view !== 'workers' && (
              <>
                <button className="btn" onClick={togglePause} title={isPaused ? `Resume ${queue}` : `Pause ${queue}`}>
                  {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  <span className="hidden sm:inline">{isPaused ? 'Resume' : 'Pause'}</span>
                </button>
                <button className="btn btn-primary" onClick={() => setAdding(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">New job</span>
                </button>
              </>
            )}
            <button className="btn btn-icon" onClick={refreshNow} disabled={refreshing} title="Refresh now" aria-label="Refresh now">
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-5 lg:px-7">
          <div className="mx-auto max-w-[1400px]">
            {view === 'overview' && (
              <Overview
                queue={queue}
                metrics={current}
                throughput={throughput?.queue === queue ? throughput.buckets : null}
                feed={feed}
                workers={workers}
                onOpenStatus={status => { setJobStatus(status); setView('jobs'); }}
                onOpenJob={showJob}
                onOpenWorkers={() => setView('workers')}
              />
            )}
            {view === 'jobs' && (
              <JobsView
                queue={queue}
                metrics={current}
                status={jobStatus}
                onStatus={setJobStatus}
                onOpenJob={showJob}
                notify={notify}
                onChanged={refresh}
              />
            )}
            {view === 'workers' && <WorkersView workers={workers} />}
            {view === 'schedules' && <SchedulesView queue={queue} />}
          </div>
        </main>
      </div>

      {openJob && (
        <JobDrawer
          key={`${openJob.queue}:${openJob.id}`}
          queue={openJob.queue}
          jobId={openJob.id}
          onClose={() => setOpenJob(null)}
          notify={notify}
          onChanged={refresh}
        />
      )}

      {adding && (
        <AddJobDialog
          queue={queue}
          onClose={() => setAdding(false)}
          onAdded={job => { setAdding(false); refresh(); showJob(queue, job.id); }}
          notify={notify}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
