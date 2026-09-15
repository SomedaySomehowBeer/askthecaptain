import type { TransactionSql } from '@captain/db';
import type { ActionStep, Step, WorkflowDefinition } from '@captain/steps';
export type HandlerContext = {
 organisationId: string; userId: string; runId: string; enablementId: string;
 path: string; itemIndex: number | null; idempotencyKey: string; step: ActionStep;
};
/** wakeAt schedules a recheck; timeoutDays remains a separate, fixed upper bound. */
export type WaitResult = { ready: boolean; key: string; output?: unknown; wakeAt?: Date };
type DatabaseHandler = { kind: 'read' | 'write'; transaction: (context: HandlerContext & { tx: TransactionSql }, args: Record<string, unknown>) => Promise<unknown> };
type ExternalHandler = { kind: 'read' | 'infer' | 'write' | 'notify';
 /** A provider write MUST implement desired-state/idempotency or reconcile using idempotencyKey. */
 retrySafe: true; call: (context: HandlerContext, args: Record<string, unknown>) => Promise<unknown> };
type AwaitHandler = { kind: 'await'; transaction: (context: HandlerContext & { tx: TransactionSql }, args: Record<string, unknown>) => Promise<WaitResult> };
export type Handler = DatabaseHandler | ExternalHandler | AwaitHandler;
/** Services remain ordinary functions. No handler or model receives the registry as a tool. */
export class Registry {
 readonly handlers = new Map<string, Handler>();
 registerStep(key: string, handler: Handler) { if (this.handlers.has(key)) throw Error(`Duplicate step ${key}`); this.handlers.set(key, handler); return this; }
 get(step: ActionStep) { const handler = this.handlers.get(step.key); if (!handler || handler.kind !== step.kind) throw Error(`Step ${step.key} is not installed`); return handler; }
 missing(definition: WorkflowDefinition): string[] {
  const visit = (steps: Step[]): string[] => steps.flatMap(s => s.kind === 'each' ? visit(s.steps) : s.kind === 'branch' ? [...visit(s.then), ...visit(s.else ?? [])] : this.handlers.get(s.key)?.kind === s.kind ? [] : [s.key]);
  return [...new Set(visit(definition.steps))];
 }
}
