import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import * as store from '../src/inference.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
let a: { organisationId: string; userId: string }, b: typeof a, member: string;
before(async () => {
 if (!databaseUrl) return; db = await freshDatabase();
 async function seed(name: string) {
  const [org] = await db.owner`insert into organisations (name) values (${name}) returning id`;
  const [user] = await db.owner`insert into users (email) values (${`${name}@example.com`}) returning id`;
  const context = { organisationId: String(org!.id), userId: String(user!.id) };
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${context.organisationId}, ${context.userId}, 'owner')`;
  await withTenant(db.app, context, async tx => {
   await store.createRuntime(tx, context.organisationId, context.userId, 'claude'); await store.setBudget(tx, context.organisationId, 10000);
   const budget = await store.budget(tx, context.organisationId);
   await store.settle(tx, context.organisationId, budget.month, { step: 'triage', tier: 'small', provider: 'claude', model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 5, latencyMs: 3 });
  }); return context;
 }
 a = await seed('inference-a'); b = await seed('inference-b');
 const [user] = await db.owner`insert into users (email) values ('inference-member@example.com') returning id`; member = String(user!.id);
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${a.organisationId}, ${member}, 'member')`;
});
after(async () => { await db?.close(); });
it('all inference tables isolate reads and deny cross-tenant writes and deletes', async () => {
 for (const table of ['inference_runtimes', 'model_budgets', 'model_usage']) {
  assert.equal((await db.app`select * from ${db.app(table)}`).length, 0);
  await withTenant(db.app, a, async tx => {
   const rows = await tx`select organisation_id from ${tx(table)}`; assert.deepEqual(rows.map(r => r.organisationId), [a.organisationId]);
  });
  await assert.rejects(withTenant(db.app, a, tx => tx`update ${tx(table)} set organisation_id = ${b.organisationId} where organisation_id = ${a.organisationId}`), { code: '42501' });
  await assert.rejects(withTenant(db.app, a, tx => tx`delete from ${tx(table)}`), { code: '42501' });
 }
 await assert.rejects(withTenant(db.app, a, tx => tx`insert into model_usage (organisation_id, step_key, tier, provider, model, input_tokens, output_tokens, latency_ms) values (${b.organisationId}, 'x', 'small', 'claude', 'x', 1, 1, 1)`), { code: '42501' });
});
it('runtime membership FK cannot refer to a person in another tenant', async () => {
 await assert.rejects(withTenant(db.app, a, tx => tx`update inference_runtimes set added_by = ${b.userId} where organisation_id = ${a.organisationId}`), { code: '23503' });
});
it('member cannot change runtime, monthly allowance or organisation default through SQL', async () => {
 const context = { organisationId: a.organisationId, userId: member };
 assert.equal((await withTenant(db.app, context, tx => tx`update inference_runtimes set status = 'ready' returning id`)).length, 0);
 await assert.rejects(withTenant(db.app, context, tx => tx`update model_budgets set limit_tokens = 99999`), { code: '42501' });
 await assert.rejects(withTenant(db.app, context, tx => tx`update model_budgets set cost_limit_micros = 99999`), { code: '42501' });
 await assert.rejects(withTenant(db.app, context, tx => tx`update organisations set settings = '{"inferenceLimitTokens":99999}' where id = ${a.organisationId}`), { code: '42501' });
 await assert.rejects(withTenant(db.app, context, tx => tx`insert into model_budgets (organisation_id, month, limit_tokens) values (${a.organisationId}, '2100-01-01', 99999)`), { code: '42501' });
});
it('budgets use first-of-month, nonnegative counts and unique tenant months', async () => {
 await assert.rejects(withTenant(db.app, a, tx => tx`insert into model_budgets (organisation_id, month, limit_tokens) values (${a.organisationId}, '2100-01-02', 10000)`), { code: '23514' });
 await assert.rejects(withTenant(db.app, a, tx => tx`update model_budgets set used_tokens = -1`), { code: '23514' });
 const month = await withTenant(db.app, a, tx => store.budget(tx, a.organisationId)); assert.equal(month.usedTokens, 15);
 await assert.rejects(withTenant(db.app, a, tx => tx`insert into model_budgets (organisation_id, month, limit_tokens) values (${a.organisationId}, ${month.month}, 10000)`), { code: '23505' });
});
it('reserves an API-provider and nullable cost fields without charging subscriptions', async () => {
 await withTenant(db.app, a, async tx => {
  const [runtime] = await tx`update inference_runtimes set provider = 'anthropic_api' returning provider`; assert.equal(runtime!.provider, 'anthropic_api');
  const [month] = await tx`select cost_limit_micros from model_budgets`; assert.equal(month!.costLimitMicros, null);
  const [usage] = await tx`select cost_micros from model_usage`; assert.equal(usage!.costMicros, null);
 });
});
