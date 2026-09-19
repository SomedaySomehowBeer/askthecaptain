import { z } from 'zod';
import { withTenant, type Sql } from '@captain/db';
import * as store from '@captain/db/inference';
import { infer, InferenceError, type InferInput, type LoginState, type Provider, type SubscriptionProviderName } from '@captain/model';
import { SpriteProvider } from '@captain/model/sprite';
import { newDataKey, open, seal } from '../connections/encryption.ts';
import { badRequest, forbidden, HttpError, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';
import { spriteFiles, SpritesError, type Provisioner } from './sprites.ts';
import { randomBytes } from 'node:crypto';
/** The sign-in hosts a shim may name; anything else is dropped rather than shown. */
export const allowedLoginUrl = (value: string) => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['claude.ai', 'platform.claude.com', 'auth.openai.com'].includes(u.hostname); } catch { return false; } };
const publicRuntime = (runtime: store.Runtime | undefined) => runtime && (({ connectionEncrypted: _, ...visible }) => visible)(runtime);
export class InferenceService {
 private readonly db: Sql; private readonly master: Buffer | null; private readonly providerFactory: (url: string, secret: string) => Provider;
 /** The Sprites API, when the platform holds a token (D18); null means runtimes cannot be created here. */
 private readonly sprites: Provisioner | null; private readonly files: typeof spriteFiles;
 constructor(db: Sql, master: Buffer | null, providerFactory: (url: string, secret: string) => Provider = (url, secret) => new SpriteProvider(url, secret), sprites: Provisioner | null = null, files: typeof spriteFiles = spriteFiles) {
  this.db = db; this.master = master; this.providerFactory = providerFactory; this.sprites = sprites; this.files = files;
 }
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
  return withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   let runtime = await store.getRuntime(tx, organisationId);
   // Setting up: once the shim answers /health the CLIs are installed and sign-in can begin. Only the owner may move the row.
   if (runtime?.status === 'provisioning' && runtime.connectionEncrypted && role === 'owner' && await this.answers(tx, organisationId, runtime)) {
    await store.runtimeState(tx, organisationId, 'needs_login'); runtime = await store.getRuntime(tx, organisationId);
   }
   // Signing in: the shim's view of the provider's own login, read live for the owner; null when it cannot be read.
   const login = runtime && ['needs_login', 'failed'].includes(runtime.status) && runtime.connectionEncrypted && role === 'owner' ? await this.loginState(tx, organisationId, runtime) : null;
   return { role, disabled: !this.master, spritesConfigured: Boolean(this.sprites), runtime: publicRuntime(runtime) ?? null, login, budget: await store.budget(tx, organisationId), usage: await store.usageByTier(tx, organisationId) };
  });
 }
 private async loginState(tx: Parameters<typeof store.getRuntime>[0], organisationId: string, runtime: store.Runtime): Promise<LoginState | null> {
  try { const provider = await this.provider(tx, organisationId, runtime); return await Promise.race([provider.loginStatus(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('slow')), 4000).unref())]); }
  catch { return null; }
 }
 /** Sign-in from Settings: the shim runs the provider's own CLI login; only its allowlisted URL and device code come back. */
 async loginStart(actor: Actor, organisationId: string): Promise<LoginState> {
  await this.owner(actor, organisationId);
  return withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   await store.dataKey(tx, organisationId);
   const runtime = await store.getRuntime(tx, organisationId, true);
   if (!runtime || !runtime.connectionEncrypted || !['needs_login', 'failed', 'ready'].includes(runtime.status)) throw badRequest('runtime_not_ready', 'Set up the runtime first. Sign-in starts once it reads Needs sign-in.');
   const provider = await this.provider(tx, organisationId, runtime);
   const state = await provider.loginStart();
   await store.loginUrl(tx, organisationId, state.url && allowedLoginUrl(state.url) ? state.url : null);
   await store.inferenceAudit(tx, organisationId, 'inference.login_started');
   return state;
  });
 }
 /** Claude's one-time authorisation code: forwarded to the shim once, held in memory only, never journaled. */
 async loginCode(actor: Actor, organisationId: string, code: string): Promise<LoginState> {
  await this.owner(actor, organisationId);
  return withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   await store.dataKey(tx, organisationId);
   const runtime = await store.getRuntime(tx, organisationId, true);
   if (!runtime || !runtime.connectionEncrypted || runtime.status === 'removed') throw badRequest('runtime_not_ready', 'Set up the runtime and start sign-in first.');
   const provider = await this.provider(tx, organisationId, runtime);
   const state = await provider.loginCode(code);
   await store.inferenceAudit(tx, organisationId, 'inference.login_code_forwarded');
   return state;
  });
 }
 private async answers(tx: Parameters<typeof store.getRuntime>[0], organisationId: string, runtime: store.Runtime) {
  try { const provider = await this.provider(tx, organisationId, runtime); await Promise.race([provider.health(), new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 4000).unref())]); return true; }
  catch { return false; }
 }
 async request(actor: Actor, organisationId: string, provider: SubscriptionProviderName) {
  await this.owner(actor, organisationId); const master = this.configured();
  // Without a Sprites token the record is created and an operator attaches a Sprite by hand (the configure route).
  if (!this.sprites) return withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   const runtime = await store.createRuntime(tx, organisationId, actor.userId, provider);
   if (!runtime) throw badRequest('runtime_exists', 'A runtime already exists. Disconnect it below before choosing another provider.');
   return { runtime: publicRuntime(runtime), instructions: 'This platform has no Sprites token configured. An operator attaches a runtime by hand, following docs/runbooks/inference-sprite.md.' };
  });
  const created = await withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   const runtime = await store.createRuntime(tx, organisationId, actor.userId, provider);
   if (!runtime) throw badRequest('runtime_exists', 'A runtime already exists. Disconnect it below before choosing another provider.');
   await store.spriteName(tx, organisationId, `captain-${organisationId}`);
   return runtime;
  });
  // The Sprite is created outside any transaction: several HTTP calls, then the connection is sealed and stored (D16).
  const spriteName = `captain-${organisationId}`; const secret = randomBytes(32).toString('hex');
  try {
   const { url, region } = await this.sprites.provision(spriteName, await this.files(provider, secret));
   new SpriteProvider(url, secret); // Enforce the exact HTTPS Sprite origin before storing it.
   await withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
    const fresh = newDataKey(master, organisationId); const wrapped = await store.dataKey(tx, organisationId, fresh.wrapped);
    const key = open(master, wrapped!, organisationId, 'data_key');
    await store.getRuntime(tx, organisationId, true);
    await store.configureRuntime(tx, organisationId, { spriteName, region, loginHint: null, loginUrl: null, status: 'provisioning', encrypted: seal(key, Buffer.from(JSON.stringify({ url, secret })), organisationId, 'inference_connection') });
   });
  } catch (error) {
   const code = error instanceof SpritesError ? `sprites_${error.op.split(' ')[0]}_${error.status}${error.reason ? `_${error.reason}` : ''}` : 'provisioning_failed';
   await withTenant(this.db, { organisationId, userId: actor.userId }, async tx => { await store.dataKey(tx, organisationId); await store.getRuntime(tx, organisationId, true); await store.runtimeState(tx, organisationId, 'failed', code); });
   throw new HttpError(503, 'provisioning_failed', `Captain could not create the runtime (${code}). Press Set up subscription again; if it keeps failing, tell the operator that code.`);
  }
  return withTenant(this.db, { organisationId, userId: actor.userId }, async tx => ({ runtime: publicRuntime(await store.getRuntime(tx, organisationId)), instructions: 'Captain is setting up your runtime. This takes a few minutes the first time; refresh to check.', created: created.id }));
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
  const runtime = await withTenant(this.db, { organisationId, userId: actor.userId }, async tx => { await store.dataKey(tx, organisationId); return store.getRuntime(tx, organisationId); });
  if (!runtime) throw notFound();
  // Destroying the Sprite removes the subscription login with it; a Sprite that is already gone is fine.
  if (this.sprites && runtime.status !== 'removed') {
   try { await this.sprites.destroy(runtime.spriteName ?? `captain-${organisationId}`); }
   catch { throw new HttpError(503, 'sprites_unavailable', 'Captain could not remove the runtime just now. Try again in a minute.'); }
  }
  await withTenant(this.db, { organisationId, userId: actor.userId }, async tx => { await store.dataKey(tx, organisationId); await store.getRuntime(tx, organisationId, true); await store.runtimeState(tx, organisationId, 'removed'); });
  return { instructions: this.sprites ? 'The runtime and its sign-in are gone. Set up a subscription again whenever you like.' : 'The connection secret has been removed from Captain. The operator must destroy the Sprite to remove its subscription login.' };
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
