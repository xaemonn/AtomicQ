import { CalendarClock, Cpu, LayoutDashboard, ListChecks, Pause } from 'lucide-react';
import type { ComponentType } from 'react';
import type { Health, Metrics } from '../lib/api';
import { compact } from '../lib/format';
import { EMPTY_METRICS } from '../lib/status';
import { AtomLogo } from './ui';

export type View = 'overview' | 'jobs' | 'workers' | 'schedules';

const NAV: Array<{ view: View; label: string; icon: ComponentType<{ className?: string }> }> = [
  { view: 'overview',  label: 'Overview',  icon: LayoutDashboard },
  { view: 'jobs',      label: 'Jobs',      icon: ListChecks },
  { view: 'workers',   label: 'Workers',   icon: Cpu },
  { view: 'schedules', label: 'Schedules', icon: CalendarClock },
];

interface Props {
  view: View;
  onView: (view: View) => void;
  queues: string[];
  queue: string;
  onQueue: (queue: string) => void;
  metrics: Record<string, Metrics>;
  paused: Record<string, boolean>;
  connected: boolean;
  health: Health | null;
  workerCount: number;
  open: boolean;
  onClose: () => void;
}

export function Sidebar(props: Props) {
  const { view, onView, queues, queue, onQueue, metrics, paused, connected, health, workerCount, open, onClose } = props;

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={onClose} />}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-white/[0.07] bg-ink-900 transition-transform duration-200 lg:static lg:translate-x-0 lg:bg-ink-900/70 ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Brand */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-white/[0.07] px-4">
          <AtomLogo className="h-7 w-7 animate-orbit text-atom" />
          <div className="leading-none">
            <div className="text-[15px] font-semibold tracking-tight text-white">
              Atomic<span className="text-atom">Q</span>
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-slate-600">job queue engine</div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2.5 py-4">
          <nav className="space-y-0.5">
            {NAV.map(({ view: v, label, icon: Icon }) => (
              <button
                key={v}
                onClick={() => { onView(v); onClose(); }}
                aria-current={view === v ? 'page' : undefined}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors ${
                  view === v
                    ? 'bg-atom/10 font-medium text-atom'
                    : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1">{label}</span>
                {v === 'workers' && <span className="num text-[11px] text-slate-500">{workerCount}</span>}
              </button>
            ))}
          </nav>

          <div className="label mb-2 mt-6 px-2.5">Queues</div>
          <div className="space-y-0.5">
            {queues.map(name => {
              const m = metrics[name] ?? EMPTY_METRICS;
              const backlog = m.waiting + m.delayed + m.active;
              const isPaused = paused[name];
              return (
                <button
                  key={name}
                  onClick={() => { onQueue(name); onClose(); }}
                  title={`${name} — ${backlog} in flight, ${m.failed} failed${isPaused ? ', paused' : ''}`}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                    queue === name ? 'bg-white/[0.07] text-white' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      isPaused ? 'bg-amber-400' : m.active > 0 ? 'animate-pulse bg-sky-400' : 'bg-slate-600'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{name}</span>
                  {isPaused && <Pause className="h-3 w-3 shrink-0 text-amber-400" />}
                  {m.failed > 0 && <span className="num shrink-0 text-[10px] text-rose-400">{compact(m.failed)}✕</span>}
                  <span className="num shrink-0 text-[11px] text-slate-500">{compact(backlog)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* System status */}
        <div className="shrink-0 space-y-2 border-t border-white/[0.07] px-4 py-3.5 text-[11px]">
          <StatusLine label="Live feed" ok={connected} okText="connected" badText="offline" />
          <StatusLine
            label="Redis"
            ok={health ? health.redisConnected : null}
            okText="ready"
            badText="unreachable"
          />
        </div>
      </aside>
    </>
  );
}

function StatusLine({ label, ok, okText, badText }: { label: string; ok: boolean | null; okText: string; badText: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${ok === null ? 'bg-slate-600' : ok ? 'bg-emerald-400' : 'bg-rose-500'}`} />
        <span className={ok === null ? 'text-slate-600' : ok ? 'text-slate-300' : 'text-rose-300'}>
          {ok === null ? '—' : ok ? okText : badText}
        </span>
      </span>
    </div>
  );
}
