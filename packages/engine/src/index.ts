import { createHash } from 'node:crypto';
import { evaluate, lookup, type ActionStep, type Step, type WorkflowDefinition } from '@captain/steps';
export type Enablement = { id: string; organisationId: string; enabledBy: string; parameters: Record<string, unknown> };
export type Snapshot = { definition: WorkflowDefinition; enablement: Enablement; trigger: unknown };
export class Park extends Error {}
/** Only a durable wait permits independent loop siblings to continue. Pauses and failures stop. */
export class Wait extends Park {}
/** Domain services supply fixed, actionable text; never pass provider exceptions to this class. */
export class WorkflowPause extends Error {}
// Postgres jsonb reorders object keys. Hash data canonically so a resumed step has the same input.
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
 item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
/** Bounded data interpreter for production workflows. No clock, I/O or model calls here. */
export async function interpret(snapshot: Snapshot, action: (path: string, step: ActionStep, args: Record<string, unknown>, skipped: boolean, itemIndex: number | null) => Promise<unknown>) {
 const walk = async (steps: Step[], scope: Record<string, unknown>, parent: string, itemIndex: number | null = null): Promise<void> => {
  let waiting = false;
  for (const [index, step] of steps.entries()) {
   const path = `${parent}.${index}`;
   if (step.kind === 'each') {
    const list = lookup(scope, step.list); if (!Array.isArray(list) || list.length > 100) throw Error('Each requires at most 100 items');
    for (const [itemIndex, item] of list.entries()) {
     try { await walk(step.steps, { ...scope, item }, `${path}[${itemIndex}].steps`, itemIndex); }
     catch (error) { if (step.independent && error instanceof Wait) waiting = true; else throw error; }
    }
   } else if (step.kind === 'branch') await walk(evaluate(step.when, scope) ? step.then : step.else ?? [], { ...scope }, `${path}.${evaluate(step.when, scope) ? 'then' : 'else'}`, itemIndex);
   else {
    const args = Object.fromEntries(Object.entries(step.args ?? {}).map(([key, value]) => [key, value && typeof value === 'object' && !Array.isArray(value) ? 'ref' in value ? lookup(scope, value.ref) : snapshot.enablement.parameters[value.param] : value]));
    const skipped = !!step.when && !evaluate(step.when, scope);
    const output = await action(path, step, args, skipped, itemIndex); if (step.as && !skipped) scope[step.as] = output;
   }
  }
  if (waiting) throw new Wait();
 };
 await walk(snapshot.definition.steps, { params: snapshot.enablement.parameters, trigger: snapshot.trigger }, 'steps');
}

export { Registry, type HandlerContext, type Handler, type WaitResult } from './registry.ts';
export { BossEngine, WorkflowProblem, queueName } from './pg-boss.ts';
