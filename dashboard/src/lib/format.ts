import type { Job, JobError } from './api';

const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export function count(n: number): string {
  return n.toLocaleString('en-US');
}

export function compact(n: number): string {
  return compactFmt.format(n);
}

/**
 * Job ids are `${Date.now()}-${uuid}`, so the leading characters are nearly
 * identical for jobs created together. The tail is what tells them apart.
 */
export function shortId(id: string): string {
  return id.length > 10 ? id.slice(-8) : id;
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function ago(ts: number, now: number): string {
  const d = now - ts;
  return d < 5000 ? 'just now' : `${duration(d)} ago`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

/** Hours and minutes only, for chart axes. */
export function minute(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { hour12: false });
}

/** The server stores errors as `{ message, stack }`; events carry them as a JSON string. */
export function parseError(err: Job['error']): JobError | null {
  if (!err) return null;
  if (typeof err === 'object') return err;
  try {
    const parsed: unknown = JSON.parse(err);
    if (parsed && typeof parsed === 'object' && 'message' in parsed) return parsed as JobError;
  } catch {
    // Not JSON — the string itself is the message
  }
  return { message: err };
}
