import { useCallback, useEffect, useRef, useState } from 'react';

/** Current time, re-rendering the caller every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * Runs `fn` once straight away and then every `intervalMs`, for as long as
 * `enabled` holds. Pass a stable (useCallback) function: a new identity restarts
 * the cycle, which is how a loader re-runs when its inputs change.
 */
export function usePolling(fn: () => void, intervalMs: number, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    fn();
    const t = setInterval(fn, intervalMs);
    return () => clearInterval(t);
  }, [fn, intervalMs, enabled]);
}

/** Calls `onEscape` when the Escape key is pressed. */
export function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEscape]);
}

export interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}

export type Notify = (kind: Toast['kind'], text: string) => void;

const TOAST_MS = 4500;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts(list => list.filter(t => t.id !== id));
  }, []);

  const notify = useCallback<Notify>((kind, text) => {
    const id = ++seq.current;
    // Keep at most four on screen
    setToasts(list => [...list.slice(-3), { id, kind, text }]);
    setTimeout(() => dismiss(id), TOAST_MS);
  }, [dismiss]);

  return { toasts, notify, dismiss };
}
