import type { ReactNode } from 'react';
import { CircleCheck, TriangleAlert, X } from 'lucide-react';
import { STATUS, statusKey } from '../lib/status';
import { useEscape } from '../lib/hooks';
import type { Toast } from '../lib/hooks';

export function AtomLogo({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.6">
        <ellipse cx="16" cy="16" rx="13" ry="5.2" />
        <ellipse cx="16" cy="16" rx="13" ry="5.2" transform="rotate(60 16 16)" />
        <ellipse cx="16" cy="16" rx="13" ry="5.2" transform="rotate(120 16 16)" />
      </g>
      <circle cx="16" cy="16" r="2.6" fill="currentColor" />
    </svg>
  );
}

export function StatusPill({ status }: { status: string }) {
  const key = statusKey(status);
  const s = STATUS[key];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${s.soft} ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.fill} ${key === 'active' ? 'animate-pulse' : ''}`} />
      {s.label}
    </span>
  );
}

export function ProgressBar({ value, status }: { value: number; status: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-16 overflow-hidden rounded-full bg-white/[0.08]">
        <div className={`h-full rounded-full transition-all duration-500 ${STATUS[statusKey(status)].fill}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="num w-8 text-right text-[11px] text-slate-500">{Math.round(pct)}%</span>
    </div>
  );
}

export function Empty({ icon, title, hint }: { icon: ReactNode; title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="text-slate-600">{icon}</div>
      <p className="text-sm font-medium text-slate-400">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-slate-600">{hint}</p>}
    </div>
  );
}

/** Centered dialog over a dimmed backdrop. Closes on Escape or backdrop click. */
export function Dialog({ title, onClose, children, footer, wide = false }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
}) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-black/70" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`panel relative flex max-h-full w-full animate-rise-in flex-col bg-ink-850 shadow-2xl shadow-black/60 ${wide ? 'max-w-lg' : 'max-w-sm'}`}
      >
        <div className="panel-head">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button className="btn btn-icon border-transparent bg-transparent" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-white/[0.06] px-4 py-3">{footer}</div>
      </div>
    </div>
  );
}

export interface ConfirmSpec {
  title: string;
  body: string;
  action: string;
  danger?: boolean;
  run: () => void;
}

export function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  return (
    <Dialog
      title={spec.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className={`btn ${spec.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => { onClose(); spec.run(); }}
          >
            {spec.action}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-slate-400">{spec.body}</p>
    </Dialog>
  );
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`panel pointer-events-auto flex animate-rise-in items-start gap-2.5 bg-ink-800 px-3 py-2.5 shadow-xl shadow-black/50 ${t.kind === 'error' ? 'border-rose-400/30' : 'border-atom/25'}`}
        >
          {t.kind === 'error'
            ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            : <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-atom" />}
          <p className="flex-1 break-words text-xs leading-relaxed text-slate-200">{t.text}</p>
          <button className="text-slate-500 hover:text-white" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
