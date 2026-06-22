import { useCallback, useState } from 'react';
import { CalendarClock, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import type { Repeatable } from '../lib/api';
import { dateTime, duration } from '../lib/format';
import { useNow, usePolling } from '../lib/hooks';
import { Empty } from './ui';

/** Cron (repeatable) job definitions registered on the selected queue. */
export function SchedulesView({ queue }: { queue: string }) {
  const [state, setState] = useState<{ queue: string; items: Repeatable[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const now = useNow();

  const load = useCallback(async () => {
    try {
      const items = await api.repeatables(queue);
      setState({ queue, items });
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [queue]);

  usePolling(load, 5000);

  // Ignore a response that belongs to the queue we just switched away from
  const items = state?.queue === queue ? state.items : null;

  return (
    <section className="panel overflow-hidden">
      <div className="panel-head">
        <div>
          <h2 className="text-sm font-semibold text-white">Repeatable jobs</h2>
          <p className="text-[11px] text-slate-500">The scheduler enqueues one job each time a cron expression comes due</p>
        </div>
      </div>

      {items === null ? (
        failed
          ? <Empty icon={<TriangleAlert className="h-7 w-7" />} title="Could not load schedules" hint="The API did not answer. Retrying automatically." />
          : <div className="px-6 py-14 text-center text-xs text-slate-600">Loading…</div>
      ) : items.length === 0 ? (
        <Empty
          icon={<CalendarClock className="h-7 w-7" />}
          title="No repeatable jobs on this queue"
          hint={<>Register one in code with <code className="font-mono text-slate-400">queue.addRepeatable(name, data, cron)</code>.</>}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-xs">
            <thead>
              <tr className="label border-b border-white/[0.06]">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Cron</th>
                <th className="px-3 py-2.5 font-medium">Next run</th>
                <th className="px-3 py-2.5 font-medium">Job options</th>
                <th className="px-4 py-2.5 font-medium">Payload</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {items.map(item => (
                <tr key={item.name} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3 font-medium text-slate-100">{item.name}</td>
                  <td className="px-3 py-3">
                    <code className="whitespace-nowrap rounded border border-violet-400/25 bg-violet-400/10 px-1.5 py-0.5 font-mono text-[11px] text-violet-200">{item.cron}</code>
                  </td>
                  <td className="px-3 py-3">
                    <div className="num text-slate-200">
                      {item.nextRunAt > now ? `in ${duration(item.nextRunAt - now)}` : 'due now'}
                    </div>
                    <div className="num text-[11px] text-slate-600">{dateTime(item.nextRunAt)}</div>
                  </td>
                  <td className="px-3 py-3 text-slate-400">
                    {item.options?.priority ?? 'normal'} priority · {item.options?.attempts ?? 3} attempts
                  </td>
                  <td className="max-w-[18rem] px-4 py-3">
                    <code className="block truncate font-mono text-[11px] text-slate-500" title={JSON.stringify(item.data)}>
                      {JSON.stringify(item.data)}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
