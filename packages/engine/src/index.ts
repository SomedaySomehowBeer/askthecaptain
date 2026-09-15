import { createHash } from 'node:crypto';
import { evaluate, lookup, type ActionStep, type Step, type WorkflowDefinition } from '@captain/steps';
export type Enablement = { id: string; organisationId: string; enabledBy: string; parameters: Record<string, unknown> };
export type Event = { key: 'outbox.sent'; draftId: string };
export interface Engine { start(definition: WorkflowDefinition, enablement: Enablement, trigger: unknown): Promise<string>; resume(runId: string, event: Event): Promise<void> }
export type Snapshot = { definition: WorkflowDefinition; enablement: Enablement; trigger: unknown };
export type Call = { runId: string; path: string; step: ActionStep; args: Record<string, unknown> };
export interface Catalogue { call(call: Call): Promise<unknown>; sent(runId: string, event: Event): Promise<void>; wasSent(draftId: string): Promise<boolean> }
export class Crash extends Error {}
export class Park extends Error {}
export class StepFailure extends Error { readonly path: string; readonly key: string; constructor(path: string, key: string, message: string) { super(message); this.path = path; this.key = key; } }
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Bounded data interpreter shared by both engines. No clock, I/O or model calls here. */
export async function interpret(snapshot: Snapshot, action: (path: string, step: ActionStep, args: Record<string, unknown>, skipped: boolean) => Promise<unknown>) {
 const walk = async (steps: Step[], scope: Record<string, unknown>, parent: string): Promise<void> => {
  for (const [index, step] of steps.entries()) {
   const path = `${parent}.${index}`;
   if (step.kind === 'each') {
    const list = lookup(scope, step.list); if (!Array.isArray(list) || list.length > 100) throw Error('Spike each requires at most 100 items');
    for (const [itemIndex, item] of list.entries()) await walk(step.steps, { ...scope, item }, `${path}[${itemIndex}].steps`);
   } else if (step.kind === 'branch') await walk(evaluate(step.when, scope) ? step.then : step.else ?? [], { ...scope }, `${path}.${evaluate(step.when, scope) ? 'then' : 'else'}`);
   else {
    const args = Object.fromEntries(Object.entries(step.args ?? {}).map(([key, value]) => [key, value && typeof value === 'object' && !Array.isArray(value) ? 'ref' in value ? lookup(scope, value.ref) : snapshot.enablement.parameters[value.param] : value]));
    const skipped = !!step.when && !evaluate(step.when, scope);
    const output = await action(path, step, args, skipped); if (step.as && !skipped) scope[step.as] = output;
   }
  }
 };
 await walk(snapshot.definition.steps, { params: snapshot.enablement.parameters, trigger: snapshot.trigger }, 'steps');
}
