import { z } from 'zod';
import { withTenant, type Sql } from '@captain/db';
import * as store from '@captain/db/inference';
import { infer, InferenceError, type InferInput, type Provider, type SubscriptionProviderName } from '@captain/model';
import { SpriteProvider } from '@captain/model/sprite';
import { newDataKey, open, seal } from '../connections/encryption.ts';
import { badRequest, forbidden, HttpError, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';
const publicRuntime = (runtime: store.Runtime | undefined) => runtime && (({ connectionEncrypted: _, ...visible }) => visible)(runtime);
export class InferenceService {
 private readonly db: Sql; private readonly master: Buffer | null; private readonly providerFactory: (url: string, secret: string) => Provider;
 constructor(db: Sql, master: Buffer | null, providerFactory: (url: string, secret: string) => Provider = (url, secret) => new SpriteProvider(url, secret)) { this.db = db; this.master = master; this.providerFactory = providerFactory; }
 private async owner(actor: Actor, organisationId: string) { if (await roleOf(this.db, actor.userId, organisationId) !== 'owner') throw forbidden('Only an owner can manage inference sign-in.'); }
 private configured() { if (!this.master) throw badRequest('runtime_not_ready', 'Inference is disabled. Ask the operator to configure encryption.'); return this.master; }
 private async provider(tx: Parameters<typeof store.getRuntime>[0], organisationId: string, runtime: store.Runtime) {
  const wrapped = await store.dataKey(tx, organisationId);
  if (!wrapped || !runtime.connectionEncrypted) throw new InferenceError('runtime_not_ready');
  try {
   const key = open(this.configured(), wrapped, organisationId, 'data_key');
   const { url, secret } = z.object({ url: z.string(), secret: z.string() }).parse(JSON.parse(open(key, runtime.connectionEncrypted, organisationId, 'inference_connection').toString()));
   return this.providerFactory(url, secret);
  } catch { throw new InferenceError('runtime_not_ready'); }
 }
 async get(actor: Actor, organisationId: string) {
  const role = await roleOf(this.db, actor.userId, organisationId);
  return withTenant(this.db, { organisationId, userId: actor.userId }, async tx => ({ role, disabled: !this.master,
   runtime: publicRuntime(await store.getRuntime(tx, organisationId)) ?? null, budget: await store.budget(tx, organisationId), usage: await store.usageByTier(tx, organisationId) }));
 }
 async request(actor: Actor, organisationId: string, provider: SubscriptionProviderName) {
  await this.owner(actor, organisationId); this.configured();
  return withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   const runtime = await store.createRuntime(tx, organisationId, actor.userId, provider);
   if (!runtime) throw badRequest('runtime_exists', 'Remove the existing runtime before choosing another provider.');
   return { runtime: publicRuntime(runtime), instructions: `The operator runs infra/sprites/provision.sh for organisation ${organisationId}, then follows docs/runbooks/inference-sprite.md to sign in and verify. Creating this record does not create a Fly resource.` };
  });
 }
 async configure(actor: Actor, organisationId: string, input: { url: string; secret: string; spriteName: string; region: string; loginHint: string | null; loginUrl: string | null }) {
  await this.owner(actor, organisationId); const master = this.configured();
  new SpriteProvider(input.url, input.secret); // Enforce the exact HTTPS Sprite origin before storing it.
  await withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   // Common lock ordering: organisation key, runtime, month.
   const fresh = newDataKey(master, organisationId); const wrapped = await store.dataKey(tx, organisationId, fresh.wrapped);
   const key = open(master, wrapped!, organisationId, 'data_key');
   const runtime = await store.getRuntime(tx, organisationId, true);
   if (!runtime || runtime.status === 'removed') throw notFound();
   if (runtime.provider === 'anthropic_api') throw new InferenceError('runtime_not_ready');
   await store.configureRuntime(tx, organisationId, { ...input, encrypted: seal(key, Buffer.from(JSON.stringify({ url: input.url, secret: input.secret })), organisationId, 'inference_connection') });
  });
 }
 async remove(actor: Actor, organisationId: string) {
  await this.owner(actor, organisationId);
  await withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   await store.dataKey(tx, organisationId);
   if (!await store.getRuntime(tx, organisationId, true)) throw notFound();
   await store.runtimeState(tx, organisationId, 'removed');
  });
  return { instructions: 'The connection secret has been removed from Captain. The operator must destroy the Sprite to remove its subscription login.' };
 }
 async setBudget(actor: Actor, organisationId: string, limit: number) {
  if (await roleOf(this.db, actor.userId, organisationId) === 'member') throw forbidden('Only an owner or admin can change the allowance.');
  await withTenant(this.db, { organisationId, userId: actor.userId }, async tx => { await store.dataKey(tx, organisationId); await store.setBudget(tx, organisationId, limit); });
 }
 async verify(actor: Actor, organisationId: string) {
  await this.owner(actor, organisationId);
  // A minimal output probe: the empty JSON object. Usage is charged to the same monthly allowance.
  return this.execute(actor, { organisationId, step: 'runtime.verify', tier: 'small', instruction: 'Return only the empty JSON object {}.', input: null, schema: z.object({}).strict(), maxTokens: 1 }, true).then(result => result.output);
 }
 /** The runner supplies the person who enabled the workflow; no identity is inferred by the model. */
 async infer<T>(actor: Actor, input: InferInput<T>): Promise<T>;
 async infer<T>(actor: Actor, input: InferInput<T>, options: { withModel: true }): Promise<{ output: T; model: string }>;
 async infer<T>(actor: Actor, input: InferInput<T>, options?: { withModel: true }): Promise<T | { output: T; model: string }> {
  const result = await this.execute(actor, input, false); return options?.withModel ? result : result.output;
 }
 private async execute<T>(actor: Actor, input: InferInput<T>, verify: boolean): Promise<{ output: T; model: string }> {
  await roleOf(this.db, actor.userId, input.organisationId); this.configured();
  const outcome = await withTenant(this.db, { organisationId: input.organisationId, userId: actor.userId }, async tx => {
   await store.dataKey(tx, input.organisationId);
   const runtime = await store.getRuntime(tx, input.organisationId, true);
   let failure: InferenceError | undefined;
   try {
    if (!runtime || runtime.status === 'removed' || runtime.provider === 'anthropic_api') throw new InferenceError('runtime_not_ready');
    if (!verify && runtime.status !== 'ready') throw new InferenceError(runtime.status === 'needs_login' ? 'needs_login' : 'runtime_not_ready');
    const provider = await this.provider(tx, input.organisationId, runtime);
    if (verify) await provider.health();
    const month = await store.budget(tx, input.organisationId);
    let model = '';
    const output = await infer(input, runtime.provider, provider, {
     before: async estimate => { if (month.usedTokens + estimate.tokens > month.limitTokens) throw new InferenceError('budget_spent'); },
     record: async result => { await store.settle(tx, input.organisationId, month.month, { ...input, provider: runtime.provider, model: result.model, ...result.usage, latencyMs: result.latencyMs }); model = result.model; month.usedTokens += result.usage.inputTokens + result.usage.outputTokens; },
     failed: async () => {}
    });
    if (verify) await store.runtimeState(tx, input.organisationId, 'ready');
    return { output, model };
   } catch (error) {
    // Return the error through commit: failed output must not roll back consumed tokens.
    failure = error instanceof InferenceError ? error : new InferenceError('provider_unavailable');
    await store.inferenceAudit(tx, input.organisationId, 'inference.failed', { step: input.step, runId: input.runId ?? null, code: failure.code });
    if (verify && runtime && runtime.status !== 'removed' && failure.code !== 'budget_spent') await store.runtimeState(tx, input.organisationId, failure.code === 'needs_login' ? 'needs_login' : 'failed', failure.code);
    return { failure };
   }
  });
  if ('failure' in outcome) throw outcome.failure; return outcome;
 }
}
export function inferenceHttpError(error: unknown): never {
 if (error instanceof InferenceError) throw new HttpError(error.code === 'budget_spent' || error.code === 'rate_limited' ? 429 : 503, error.code, {
  runtime_not_ready: 'Inference is not ready. Ask the owner to configure and verify its runtime.', needs_login: 'Sign in to the subscription on the Sprite, then verify again.',
  rate_limited: 'The subscription is rate limited. Try again later.', provider_unavailable: 'The provider is unavailable. Try again later.', invalid_output: 'The model returned invalid data twice. Retry this step later.', budget_spent: 'The monthly token allowance is spent or too small for this call. Ask an owner or admin to increase it.'
 }[error.code]);
 throw error;
}
