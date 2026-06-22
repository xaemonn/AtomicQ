import { Cpu } from 'lucide-react';
import type { WorkerInfo } from '../lib/api';
import { count, duration } from '../lib/format';
import { useNow } from '../lib/hooks';
import { workerHealth } from '../lib/status';
import { Empty } from './ui';

/** Every worker process currently reporting a heartbeat, across all queues. */
export function WorkersView({ workers }: { workers: WorkerInfo[] }) {
  const now = useNow();
  const slots = workers.reduce((sum, w) => sum + (Number(w.concurrency) || 1), 0);
  const busy = workers.reduce((sum, w) => sum + (w.currentJob ? w.currentJob.split(',').length : 0), 0);
  const processed = workers.reduce((sum, w) => sum + (Number(w.jobsProcessed) || 0), 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Workers online" value={count(workers.length)} />
        <Stat label="Busy slots" value={`${busy} / ${slots}`} />
        <Stat label="Utilisation" value={slots > 0 ? `${Math.round((busy / slots) * 100)}%` : '—'} />
        <Stat label="Jobs processed" value={count(processed)} hint="since each worker started" />
      </div>

      <section className="panel overflow-hidden">
        <div className="panel-head">
          <div>
            <h2 className="text-sm font-semibold text-white">Worker processes</h2>
            <p className="text-[11px] text-slate-500">A worker drops off this list three missed heartbeats after it stops reporting</p>
          </div>
        </div>

        {workers.length === 0 ? (
          <Empty
            icon={<Cpu className="h-7 w-7" />}
            title="No workers online"
            hint="Start the server with workers enabled, or scale the worker service: docker compose up -d --scale worker=3"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead>
                <tr className="label border-b border-white/[0.06]">
                  <th className="px-4 py-2.5 font-medium">Worker</th>
                  <th className="px-3 py-2.5 font-medium">Queues</th>
                  <th className="px-3 py-2.5 font-medium">Slots</th>
                  <th className="px-3 py-2.5 text-right font-medium">Processed</th>
                  <th className="px-3 py-2.5 text-right font-medium">Uptime</th>
                  <th className="px-4 py-2.5 text-right font-medium">Heartbeat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {workers.map((w, i) => {
                  const health = workerHealth(w, now);
                  const size = Number(w.concurrency) || 1;
                  const inUse = w.currentJob ? w.currentJob.split(',').length : 0;
                  const beat = now - (Number(w.lastHeartbeat) || 0);
                  return (
                    <tr key={w.id ?? `${w.host}:${w.pid}:${i}`} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${health.dot}`} />
                          <div className="min-w-0">
                            <div className="truncate font-mono text-slate-200">{w.host}</div>
                            <div className="num text-[11px] text-slate-500">pid {w.pid}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {w.queues.split(',').filter(Boolean).map(name => (
                            <span key={name} className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[11px] text-slate-400">{name}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2" title={`${inUse} of ${size} slots busy`}>
                          <div className="flex flex-wrap gap-[3px]">
                            {Array.from({ length: Math.min(size, 24) }, (_, slot) => (
                              <span key={slot} className={`h-3 w-1.5 rounded-sm ${slot < inUse ? 'bg-sky-400' : 'bg-white/10'}`} />
                            ))}
                          </div>
                          <span className="num text-[11px] text-slate-500">{inUse}/{size}</span>
                        </div>
                      </td>
                      <td className="num px-3 py-3 text-right text-slate-200">{count(Number(w.jobsProcessed) || 0)}</td>
                      <td className="num px-3 py-3 text-right text-slate-400">{duration(now - (Number(w.startedAt) || now))}</td>
                      <td className={`num px-4 py-3 text-right ${health.text}`}>
                        {beat < 2000 ? 'just now' : `${duration(beat)} ago`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel px-4 py-3.5">
      <div className="label">{label}</div>
      <div className="num mt-1.5 text-2xl font-semibold text-white">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-600">{hint}</div>}
    </div>
  );
}
