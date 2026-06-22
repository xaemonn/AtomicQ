import { useId, useState } from 'react';
import type { MouseEvent } from 'react';
import type { ThroughputBucket } from '../lib/api';
import { minute } from '../lib/format';

const W = 640;
const H = 210;
const PAD = { left: 34, right: 14, top: 14, bottom: 26 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const COMPLETED = '#34d399';
const FAILED = '#fb7185';

/** Rounds up to 1, 2 or 5 × 10ⁿ so the axis ends on a readable number. */
function niceMax(v: number): number {
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

// Labelled in the viewer's timezone; the server's own label is the fallback
const label = (b: ThroughputBucket) => (b.timestamp ? minute(b.timestamp) : b.time);

/** Completed vs failed jobs per minute as two lines over a shared axis. */
export function ThroughputChart({ buckets }: { buckets: ThroughputBucket[] }) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const last = buckets.length - 1;
  const max = niceMax(Math.max(1, ...buckets.flatMap(b => [b.completed, b.failed])));
  const x = (i: number) => PAD.left + (last === 0 ? PLOT_W / 2 : (i / last) * PLOT_W);
  const y = (v: number) => PAD.top + (1 - v / max) * PLOT_H;
  const line = (pick: (b: ThroughputBucket) => number) =>
    buckets.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pick(b)).toFixed(1)}`).join(' ');

  const completedLine = line(b => b.completed);
  const failedLine = line(b => b.failed);
  const area = `${completedLine} L${x(last).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const ticks = max >= 2 ? [0, max / 2, max] : [0, max];

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - PAD.left) / PLOT_W) * last);
    setHover(Math.max(0, Math.min(last, i)));
  };

  const hovered = hover !== null ? buckets[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Completed and failed jobs per minute over the last ten minutes"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={COMPLETED} stopOpacity="0.28" />
            <stop offset="100%" stopColor={COMPLETED} stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,0.06)" strokeDasharray={t === 0 ? undefined : '3 4'} />
            <text x={PAD.left - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="#64748b" fontFamily="ui-monospace, monospace">{t}</text>
          </g>
        ))}

        {buckets.map((b, i) => (
          // Every other label, always including the newest bucket
          (last - i) % 2 === 0 && (
            <text key={i} x={x(i)} y={H - 8} textAnchor={i === last ? 'end' : i === 0 ? 'start' : 'middle'} fontSize="10" fill="#64748b" fontFamily="ui-monospace, monospace">{label(b)}</text>
          )
        ))}

        <path d={area} fill={`url(#${gradientId})`} />
        <path d={completedLine} fill="none" stroke={COMPLETED} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={failedLine} fill="none" stroke={FAILED} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="5 4" />

        {hover !== null && hovered && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={y(0)} stroke="rgba(255,255,255,0.18)" />
            <circle cx={x(hover)} cy={y(hovered.completed)} r="4" fill={COMPLETED} stroke="#0c0f15" strokeWidth="2" />
            <circle cx={x(hover)} cy={y(hovered.failed)} r="4" fill={FAILED} stroke="#0c0f15" strokeWidth="2" />
          </g>
        )}
      </svg>

      {hover !== null && hovered && (
        <div
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-ink-800 px-2.5 py-1.5 text-[11px] shadow-lg shadow-black/50"
          style={{ left: `${Math.max(12, Math.min(88, (x(hover) / W) * 100))}%` }}
        >
          <div className="num mb-1 text-slate-500">{label(hovered)}</div>
          <div className="flex items-center gap-1.5 text-slate-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span className="num">{hovered.completed}</span> completed
          </div>
          <div className="flex items-center gap-1.5 text-slate-200">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
            <span className="num">{hovered.failed}</span> failed
          </div>
        </div>
      )}
    </div>
  );
}
