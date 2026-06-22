import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../lib/api';
import type { Job } from '../lib/api';
import type { Notify } from '../lib/hooks';
import { Dialog } from './ui';

interface Props {
  queue: string;
  onClose: () => void;
  onAdded: (job: Job) => void;
  notify: Notify;
}

const FORM_ID = 'add-job-form';

/** Enqueues one job on the selected queue. */
export function AddJobDialog({ queue, onClose, onAdded, notify }: Props) {
  const [name, setName] = useState('');
  const [payload, setPayload] = useState('{\n  \n}');
  const [priority, setPriority] = useState('normal');
  const [delaySec, setDelaySec] = useState('0');
  const [attempts, setAttempts] = useState('3');
  const [problem, setProblem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setProblem('Give the job a name.');

    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return setProblem('Payload is not valid JSON.');
    }

    const delay = Number(delaySec);
    const maxAttempts = Number(attempts);
    if (!Number.isFinite(delay) || delay < 0) return setProblem('Delay must be zero or more seconds.');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return setProblem('Attempts must be a whole number, 1 or more.');

    setProblem(null);
    setSubmitting(true);
    try {
      const job = await api.addJob(queue, {
        name: name.trim(),
        data,
        options: { priority, attempts: maxAttempts, ...(delay > 0 ? { delay: Math.round(delay * 1000) } : {}) },
      });
      notify('ok', `Added "${job.name}" to ${queue}`);
      onAdded(job);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not add the job.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      wide
      title={`New job on ${queue}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form={FORM_ID} disabled={submitting}>
            {submitting ? 'Adding…' : 'Add job'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="label mb-1.5 block">Job name</span>
          <input
            className="field font-mono"
            placeholder="send-email"
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
          />
        </label>

        <label className="block">
          <span className="label mb-1.5 block">Payload (JSON)</span>
          <textarea
            className="field h-32 resize-y py-2 font-mono text-xs leading-relaxed"
            value={payload}
            onChange={e => setPayload(e.target.value)}
            spellCheck={false}
          />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="label mb-1.5 block">Priority</span>
            <select className="field" value={priority} onChange={e => setPriority(e.target.value)}>
              <option value="high">high</option>
              <option value="normal">normal</option>
              <option value="low">low</option>
            </select>
          </label>
          <label className="block">
            <span className="label mb-1.5 block">Delay (s)</span>
            <input className="field num" type="number" min="0" step="any" value={delaySec} onChange={e => setDelaySec(e.target.value)} />
          </label>
          <label className="block">
            <span className="label mb-1.5 block">Attempts</span>
            <input className="field num" type="number" min="1" step="1" value={attempts} onChange={e => setAttempts(e.target.value)} />
          </label>
        </div>

        {problem && <p role="alert" className="text-xs text-rose-300">{problem}</p>}
      </form>
    </Dialog>
  );
}
