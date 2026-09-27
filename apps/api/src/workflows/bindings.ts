import type { Handler } from '@captain/engine';
import type { z } from 'zod';
import type { InferenceService } from '../inference/service.ts';
/** Data-only inference adapter, exercised by the engine integration tests: fixed instructions/schemas are code, input is data.
 * Inference records actual usage on every attempt; a crash may incur another inference charge. */
export function inferenceStep<T>(service: InferenceService, instruction: string, schema: z.ZodType<T>): Handler {
 return { kind: 'infer', retrySafe: true, call: (context, input) => service.infer({ userId: context.userId, requestId: context.runId }, {
  organisationId: context.organisationId, runId: context.runId, step: context.step.key, tier: context.step.tier!, instruction, input, schema
 }) };
}
