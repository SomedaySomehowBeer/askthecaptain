import type { TransactionSql } from '@captain/db';
import { WorkflowPause } from '@captain/engine';
export type ChaseTask = { id: string; title: string; status: string; ownerId: string | null; due: string | null; active: boolean; today: string; timezone: string; ready: boolean; wakeAt: Date | null };
/** Due dates are dates in the organisation, never UTC midnight or the server's local timezone. */
export async function dueTasks(tx: TransactionSql, org: string, withinDays: number, now: Date) {
 const rows = await tx<{ id: string; title: string; status: string; ownerId: string | null; due: string }[]>`select t.id, left(t.title, 300) as title, t.status, t.owner_id, t.due::text
  from tasks t join organisations o on o.id = t.organisation_id where t.organisation_id = ${org} and t.status in ('open', 'in_progress')
  and t.due <= (${now.toISOString()}::timestamptz at time zone o.timezone)::date + ${withinDays}::int order by t.due, t.id limit 101`;
 if (rows.length > 100) throw new WorkflowPause('More than 100 tasks need chasing. Complete or cancel obsolete tasks, or reduce the look-ahead window, then start a new run.');
 return rows;
}
export async function taskAtTime(tx: TransactionSql, org: string, id: string, phase: 'before' | 'after', daysBefore: number, now: Date): Promise<ChaseTask> {
 const [clock] = await tx`select timezone, (${now.toISOString()}::timestamptz at time zone timezone)::date::text as today from organisations where id = ${org}`;
 const [task] = await tx`select id, left(title, 300) as title, status, owner_id, due::text,
  (due + ${phase === 'after' ? 1 : -daysBefore}::int)::text as target,
  ((due + ${phase === 'after' ? 1 : -daysBefore}::int)::timestamp + interval '7 hours') at time zone ${clock!.timezone} as wake_at
  from tasks where id = ${id} and organisation_id = ${org} for share`;
 const active = !!task && ['open', 'in_progress'].includes(task.status) && !!task.due;
 return { id, title: task?.title ?? '', status: task?.status ?? 'missing', ownerId: task?.ownerId ?? null, due: task?.due ?? null,
  active, today: clock!.today, timezone: clock!.timezone, ready: !active || clock!.today >= task!.target, wakeAt: active ? task!.wakeAt : null };
}
