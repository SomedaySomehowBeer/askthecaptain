import type { Handler, HandlerContext } from '@captain/engine';
import type { z } from 'zod';
import type { InferenceService } from '../inference/service.ts';
import type { PushService } from '../push/service.ts';
/** Catalogue bindings used by the inbox slice: fixed instructions/schemas are code, input is data.
 * Inference records actual usage on every attempt; a crash may incur another inference charge. */
export function inferenceStep<T>(service: InferenceService, instruction: string, schema: z.ZodType<T>): Handler {
 return { kind: 'infer', retrySafe: true, call: (context, input) => service.infer({ userId: context.userId, requestId: context.runId }, {
  organisationId: context.organisationId, runId: context.runId, step: context.step.key, tier: context.step.tier!, instruction, input, schema
 }) };
}
/** Repeated push replaces the same visible notification (tag); delivery receipts can repeat. */
export function notificationStep(service: PushService, recipient: (context: HandlerContext, input: Record<string, unknown>) => Promise<string>): Handler {
 return { kind: 'notify', retrySafe: true, call: async (context, input) => service.send(context.organisationId, await recipient(context, input), {
  title: 'Captain has an update', body: 'Open Captain to review it.', url: '/settings/workflows', tag: context.idempotencyKey
 }, { runId: context.runId, actor: { userId: context.userId, requestId: context.runId } }) };
}
