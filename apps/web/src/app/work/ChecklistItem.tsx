'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { saveRecord, type Result } from './record-actions.ts';

/** Complete/reopen in place. Only a confirmed write changes the checkmark; ambiguous writes lock. */
export function ChecklistItem({ task, parentHref }: {
 task: { id: string; title: string; status: string; revision: number }; parentHref: string;
}) {
 const router = useRouter();
 const [status, setStatus] = useState(task.status);
 const [result, setResult] = useState<Result | null>(null);
 const [pending, start] = useTransition();
 const sending = useRef(false);
 const locked = pending || result?.ok === true || (result !== null && !result.ok && !!result.locked);
 function toggle() {
  if (sending.current || locked || status === 'cancelled') return;
  sending.current = true;
  const next = status === 'done' ? 'open' : 'done';
  const form = new FormData();
  for (const [key, value] of Object.entries({ kind: 'tasks', id: task.id, expectedRevision: String(task.revision), operation: 'status', status: next })) form.set(key, value);
  start(async () => {
   let saved: Result;
   try { saved = await saveRecord(form); }
   catch { saved = { ok: false, error: 'The save could not be confirmed. Reload the checklist before trying again.', locked: true }; }
   setResult(saved);
   if (saved.ok) { setStatus(next); router.refresh(); }
   // The next confirmed revision remounts this row; do not reuse the old revision while refreshing.
   else sending.current = false;
  });
 }
 return <li className="work-task work-checklist-item" aria-busy={pending || undefined}>
  <label className="work-checklist-item__toggle">
   <input type="checkbox" checked={status === 'done'} disabled={locked || status === 'cancelled'} onChange={toggle} aria-label={`Complete ${task.title}`} />
  </label>
  <Link className="work-task__link" href={`/work/tasks/${task.id}`}><span className="work-task__title">{task.title}</span><span className="work-task__meta">{pending ? 'Saving…' : status.replaceAll('_', ' ')}{status === 'cancelled' ? ' · Open item to reopen' : ''}</span></Link>
  {result?.ok ? <p className="work-checklist-item__saved" role="status">Saved. <a href={parentHref}>Reload checklist</a></p> : null}
  {result && !result.ok ? <div className="work-checklist-item__error" role="alert"><p>{result.error}</p>{result.locked ? <a href={parentHref}>Reload checklist</a> : null}</div> : null}
 </li>;
}
