import { withTenant, type Sql } from '@captain/db';
import { answerInstruction, answerStep } from '@captain/steps';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { HttpError, notFound } from '../errors.ts';
import { inferenceHttpError, type InferenceService } from '../inference/service.ts';
import { RateLimited, RateLimiter } from '../ratelimit.ts';
import { roleOf, type Actor } from '../tenant.ts';
import { retrieve, type Source } from './retrieve.ts';
export const questionSchema = z.string().trim().min(1).max(1000);
export const answerSchema = z.object({ answer: z.string().trim().min(1).max(2000), sources: z.array(z.string().min(1).max(200)).max(40), confidence: z.enum(['from_data', 'partly', 'not_in_data']) }).strict();
export type Answer = { id: string; question: string; answer: string; sources: Source[]; confidence: z.infer<typeof answerSchema>['confidence']; model: string; createdAt: Date };
export type Availability = { code: string; message: string } | null;
export class AnswerService {
 readonly db: Sql; readonly inference?: InferenceService; readonly limiter: RateLimiter; readonly now: () => Date;
 constructor(db: Sql, inference?: InferenceService, limiter = new RateLimiter(), now = () => new Date()) { this.db = db; this.inference = inference; this.limiter = limiter; this.now = now; }
 async availability(actor: Actor, org: string): Promise<Availability> {
  if (!this.inference) return { code: 'runtime_not_ready', message: 'Questions are unavailable. Ask the operator to configure inference, then check Settings → Inference.' };
  const state = await this.inference.get(actor, org);
  if (state.disabled || !state.runtime || state.runtime.status !== 'ready' || state.runtime.provider === 'anthropic_api') return {
   code: state.runtime?.status === 'needs_login' ? 'needs_login' : 'runtime_not_ready',
   message: state.runtime?.status === 'needs_login' ? 'Inference needs sign-in. Ask the owner to sign in and verify it in Settings → Inference.' : 'Inference is not ready. Ask the owner to finish setup and verify it in Settings → Inference.' };
  if (state.budget.usedTokens >= state.budget.limitTokens) return { code: 'budget_spent', message: 'The monthly token allowance is spent. Ask an owner or admin to increase it in Settings → Inference, or wait for next month.' };
  return null;
 }
 async list(actor: Actor, org: string, limit = 3) {
  await roleOf(this.db, actor.userId, org); limit = z.number().int().min(1).max(10).parse(limit);
  const availability = await this.availability(actor, org);
  return withTenant(this.db, { organisationId: org, userId: actor.userId }, async tx => {
   const [clock] = await tx`select timezone from organisations where id = ${org}`;
   const answers = await tx<Answer[]>`select id, question, answer, sources, confidence, model, created_at from answers where asked_by = ${actor.userId} order by created_at desc, id desc limit ${limit}`;
   return { answers, availability, timezone: clock!.timezone as string };
  });
 }
 async ask(actor: Actor, org: string, question: string): Promise<Answer> {
  question = questionSchema.parse(question); await roleOf(this.db, actor.userId, org);
  const rate = this.limiter.hit(`answers:${org}`, 30, 3_600_000); if (!rate.allowed) throw new RateLimited(rate.retryAfterSeconds, 'questions for this organisation');
  const state = await this.availability(actor, org); if (state) throw new HttpError(state.code === 'budget_spent' ? 429 : 503, state.code, state.message);
  const data = await withTenant(this.db, { organisationId: org, userId: actor.userId }, tx => retrieve(this.db, tx, org, question, this.now()));
  let inferred: { output: z.infer<typeof answerSchema>; model: string };
  try { inferred = await this.inference!.infer(actor, { organisationId: org, step: answerStep.key, tier: 'large', instruction: answerInstruction, schema: answerSchema, input: { question, untrustedRetrievedData: data } }, { withModel: true }); }
  catch (error) { inferenceHttpError(error); }
  const allowed = new Map(data.rows.map(r => [r.source.id, r.source]));
  const sources = [...new Set(inferred.output.sources)].flatMap(id => allowed.has(id) ? [allowed.get(id)!] : []);
  let confidence = inferred.output.confidence, answer = inferred.output.answer;
  if (!sources.length) { confidence = 'not_in_data'; if (inferred.output.confidence !== 'not_in_data') answer = 'I could not support an answer with the retrieved records. Try a full name or email, a source such as tasks or invoices, and a date range.'; }
  else if (confidence === 'from_data' && (data.warnings.length || sources.length < new Set(inferred.output.sources).size)) confidence = 'partly';
  // Limits remain visible even if the model omitted them. Source links are server-owned, never model URLs.
  if (data.warnings.length) answer = `${answer.slice(0, 1200)}\n\nData limits: ${data.warnings.join(' ').slice(0, 780)}`;
  return withTenant(this.db, { organisationId: org, userId: actor.userId }, async tx => {
   const [member] = await tx`select 1 from memberships where organisation_id = ${org} and user_id = ${actor.userId} and status = 'active' for share`; if (!member) throw notFound();
   const [saved] = await tx<Answer[]>`insert into answers (organisation_id, asked_by, question, answer, sources, confidence, model)
    values (${org}, ${actor.userId}, ${question}, ${answer}, ${tx.json(sources)}, ${confidence}, ${inferred.model}) returning id, question, answer, sources, confidence, model, created_at`;
   await audit(tx, { organisationId: org, actor: { kind: 'person', id: actor.userId }, action: 'answer.created', subjectType: 'answer', subjectId: saved!.id, requestId: actor.requestId });
   return saved!;
  });
 }
}
