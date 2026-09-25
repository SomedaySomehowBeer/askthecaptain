'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition, type ReactNode } from 'react';
import { useTaskFeedback } from './TaskListFeedback.tsx';
import { saveRecord, type Result } from './record-actions.ts';

/** Complete/reopen in place. Only a confirmed write changes the checkmark; ambiguous writes lock. */
export function TaskCheckRow({ task, parentHref, children, variant = 'checklist' }: {
 task: { id: string; title: string; status: string; revision: number }; parentHref: string; children?: ReactNode; variant?: 'checklist' | 'task';
}) {
 const router = useRouter();
 const feedback = useTaskFeedback();
 const checkbox = useRef<HTMLInputElement>(null);
 const reload = variant === 'checklist' ? 'Reload checklist' : 'Reload work';
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
   catch { saved = { ok: false, error: 'The save could not be confirmed. Reload the saved work before trying again.', locked: true }; }
   setResult(saved);
   if (saved.ok) {
    const hasFocus = document.activeElement === checkbox.current || document.activeElement === document.body;
    feedback?.(`${task.title} ${next === 'done' ? 'completed' : 'reopened'}.`, hasFocus);
    setStatus(next); router.refresh();
   }
   // The next confirmed revision remounts this row; do not reuse the old revision while refreshing.
   else sending.current = false;
  });
 }
 return <li className={`work-task work-checklist-item${variant === 'task' ? ' work-check-row' : ''}`} aria-busy={pending || undefined}>
  <label className="work-checklist-item__toggle">
   <input ref={checkbox} type="checkbox" checked={status === 'done'} disabled={locked || status === 'cancelled'} onChange={toggle} aria-label={`Complete ${task.title}`} />
  </label>
  <Link className="work-task__link" href={`/work/tasks/${task.id}`}>{children ?? <><span className="work-task__title">{task.title}</span>{pending || !['open', 'done'].includes(status) ? <span className="work-task__meta">{pending ? 'Saving…' : status.replaceAll('_', ' ')}{status === 'cancelled' ? ' · Open item to reopen' : ''}</span> : null}</>}</Link>
  {pending && variant === 'task' ? <p className="work-checklist-item__saved" role="status">Saving…</p> : null}
  {result?.ok ? <p className="work-checklist-item__saved" role={feedback ? undefined : 'status'}>Saved. <a href={parentHref}>{reload}</a></p> : null}
  {result && !result.ok ? <div className="work-checklist-item__error" role="alert"><p>{result.error}</p>{result.locked ? <a href={parentHref}>{reload}</a> : <Link href={`/work/tasks/${task.id}`}>Open task</Link>}</div> : null}
 </li>;
}

export function ChecklistItem(props: { task: { id: string; title: string; status: string; revision: number }; parentHref: string }) {
 return <TaskCheckRow {...props}/>;
}
