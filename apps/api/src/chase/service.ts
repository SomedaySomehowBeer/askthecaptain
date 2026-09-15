import { withTenant, type Sql } from '@captain/db';
import { WorkflowPause, type HandlerContext, type Registry } from '@captain/engine';
import { draftChaserInstruction } from '@captain/steps';
import { z } from 'zod';
import { dueTasks, taskAtTime } from '../commitments/chase.ts';
import type { PushService } from '../push/service.ts';
import type { InferenceService } from '../inference/service.ts';
import { draftSchema } from '../triage/data.ts';
const taskId = (args: Record<string, unknown>) => z.object({ id: z.uuid() }).parse(args.task).id;
const days = (value: unknown) => z.number().int().min(0).max(60).parse(value);
export class ChaseService {
 readonly db: Sql; readonly now: () => Date;
 constructor(db: Sql, now = () => new Date()) { this.db = db; this.now = now; }
 register(registry: Registry, inference: InferenceService, push: PushService) {
  registry.registerStep('tasks.due', { kind: 'read', transaction: (ctx, args) => dueTasks(ctx.tx, ctx.organisationId, days(args.withinDays), this.now()) });
  for (const phase of ['before', 'after'] as const) registry.registerStep(phase === 'before' ? 'time.beforeDue' : 'time.afterDue', { kind: 'await', transaction: async (ctx, args) => {
   const task = await taskAtTime(ctx.tx, ctx.organisationId, taskId(args), phase, phase === 'before' ? days(args.daysBefore) : 0, this.now());
   return { ready: task.ready, key: `task:${task.id}`, output: task, ...(task.ready ? {} : { wakeAt: task.wakeAt! }) };
  } });
  registry.registerStep('push.taskOwner', { kind: 'notify', retrySafe: true, call: (ctx, args) => this.notify(push, ctx, args, 'before') });
  registry.registerStep('push.escalate', { kind: 'notify', retrySafe: true, call: (ctx, args) => this.notify(push, ctx, args, 'after') });
  registry.registerStep('draftChaser', { kind: 'infer', retrySafe: true, call: (ctx, args) => inference.infer({ userId: ctx.userId, requestId: ctx.runId }, {
   organisationId: ctx.organisationId, runId: ctx.runId, step: ctx.step.key, tier: 'large', instruction: draftChaserInstruction,
   schema: draftSchema, input: { untrustedInvoice: args.invoice }
  }) });
  return registry;
 }
 async notify(push: PushService, ctx: HandlerContext, args: Record<string, unknown>, phase: 'before' | 'after') {
  // The await's saved output makes predicates deterministic; recheck before external I/O as well.
  const recipient = await withTenant(this.db, ctx, async tx => {
   const task = await taskAtTime(tx, ctx.organisationId, taskId(args), phase, phase === 'before' ? days(args.daysBefore) : 0, this.now());
   if (!task.active || !task.ready) return { skipped: 'The task is complete, removed, undated or its due date moved.' } as const;
   const userId = phase === 'before' ? task.ownerId ?? ctx.userId : ctx.userId;
   const [member] = await tx`select 1 from memberships where organisation_id = ${ctx.organisationId} and user_id = ${userId} and status = 'active' for share`;
   if (!member) throw new WorkflowPause('The task owner is no longer an active member. Reassign the task in Commitments, then Resume.');
   return { userId, task };
  });
  if ('skipped' in recipient) return recipient;
  const deliveries = await push.send(ctx.organisationId, recipient.userId, { title: `${phase === 'after' ? 'Overdue: ' : 'Due soon: '}${recipient.task.title}`, body: `Due ${recipient.task.due}. Open Commitments to review it.`, url: '/commitments', tag: `chase:${ctx.organisationId}:task:${recipient.task.id}` }, { runId: ctx.runId, actor: { userId: ctx.userId, requestId: ctx.runId } });
  if (!deliveries.some(d => d.state === 'sent')) throw new WorkflowPause('The reminder could not reach its recipient. Check their device in Settings → Notifications, then Resume.');
  return { recipientId: recipient.userId, sent: deliveries.filter(d => d.state === 'sent').length };
 }
}
