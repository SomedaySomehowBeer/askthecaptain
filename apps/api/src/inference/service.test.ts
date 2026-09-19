import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withTenant } from '@captain/db';
import { InferenceError, StubProvider, type Result } from '@captain/model';
import { freshDatabase, databaseUrl, type Harness } from '../../../../packages/db/test/harness.ts';
import { InferenceService } from './service.ts';
import { SpritesError } from './sprites.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
const reply = (output: unknown): Result => ({ output, usage: { inputTokens: 60, outputTokens: 40 }, model: 'claude-sonnet-5', latencyMs: 10 });
async function fixture() {
 const suffix = randomBytes(6).toString('hex');
 const [org] = await db.owner`insert into organisations (name) values (${suffix}) returning id`;
 const [user] = await db.owner`insert into users (email) values (${suffix + '@example.com'}) returning id`;
 const organisationId = String(org!.id), actor = { userId: String(user!.id), requestId: suffix };
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${organisationId}, ${actor.userId}, 'owner')`;
 const stub = new StubProvider([reply({})]); const master = randomBytes(32);
 const service = new InferenceService(db.app, master, () => stub);
 await service.request(actor, organisationId, 'claude'); await service.setBudget(actor, organisationId, 10000);
 await service.configure(actor, organisationId, { url: 'https://tenant-example.sprites.app/', secret: 'a'.repeat(64), spriteName: 'tenant-example', region: 'unknown', loginHint: 'tenant@example.com', loginUrl: null });
 await service.verify(actor, organisationId);
 const input = { organisationId, step: 'triage', tier: 'small' as const, instruction: 'Read data.', input: { text: 'private-mail-marker' }, schema: z.object({ urgent: z.boolean() }), maxTokens: 32 };
 return { service, stub, actor, organisationId, input, master };
}
it('real Postgres check and settlement survives invalid output; API reads expose no secrets or content', async () => {
 const f = await fixture(); f.stub.responses.push(reply({ urgent: true }));
 assert.deepEqual(await f.service.infer(f.actor, f.input), { urgent: true });
 f.stub.responses.push(reply({ urgent: 'private-mail-marker' }), reply({ urgent: 'private-mail-marker' }));
 await assert.rejects(f.service.infer(f.actor, f.input), { code: 'invalid_output' });
 const state = await f.service.get(f.actor, f.organisationId); assert.equal(state.budget.usedTokens, 400); assert.equal(state.usage[0]!.calls, 4);
 assert.ok(!JSON.stringify(state).includes('connectionEncrypted')); assert.ok(!JSON.stringify(state).includes('a'.repeat(64)));
 const events = await db.owner`select detail from audit_events where organisation_id = ${f.organisationId}`;
 assert.ok(!JSON.stringify(events).includes('private-mail-marker'));
 const [stored] = await db.owner`select connection_encrypted from inference_runtimes where organisation_id = ${f.organisationId}`;
 assert.ok(!Buffer.from(stored!.connectionEncrypted).includes(Buffer.from('a'.repeat(64))));
 await f.service.setBudget(f.actor, f.organisationId, 400);
 const count = f.stub.requests.length; await assert.rejects(f.service.infer(f.actor, f.input), { code: 'budget_spent' }); assert.equal(f.stub.requests.length, count);
});
it('simultaneous calls cannot both pass against the same remaining allowance', async () => {
 const f = await fixture(); await f.service.setBudget(f.actor, f.organisationId, 300); f.stub.responses.push(reply({ urgent: true }), reply({ urgent: true }));
 const values = await Promise.allSettled([f.service.infer(f.actor, f.input), f.service.infer(f.actor, f.input)]);
 assert.equal(values.filter(v => v.status === 'fulfilled').length, 1);
 const rejected = values.find(v => v.status === 'rejected') as PromiseRejectedResult; assert.equal(rejected.reason.code, 'budget_spent');
});
it('verification records needs-login; removal clears credentials and prevents inference', async () => {
 const f = await fixture(); f.stub.responses.push(new InferenceError('needs_login'));
 await assert.rejects(f.service.verify(f.actor, f.organisationId), { code: 'needs_login' });
 assert.equal((await f.service.get(f.actor, f.organisationId)).runtime?.status, 'needs_login');
 await f.service.remove(f.actor, f.organisationId);
 await assert.rejects(f.service.infer(f.actor, f.input), { code: 'runtime_not_ready' });
 const [row] = await withTenant(db.app, { organisationId: f.organisationId, userId: f.actor.userId }, tx => tx`select connection_encrypted from inference_runtimes`);
 assert.equal(row!.connectionEncrypted, null);
});
it('nonmembers and members cannot configure the runtime or allowance', async () => {
 const f = await fixture(), outsider = await fixture();
 await assert.rejects(f.service.get(outsider.actor, f.organisationId), { status: 404 });
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${f.organisationId}, ${outsider.actor.userId}, 'member')`;
 await assert.rejects(f.service.setBudget(outsider.actor, f.organisationId, 99999), { status: 403 });
 await assert.rejects(f.service.verify(outsider.actor, f.organisationId), { status: 403 });
 await assert.rejects(f.service.remove(outsider.actor, f.organisationId), { status: 403 });
 f.stub.responses.push(reply({ urgent: true }));
 assert.deepEqual(await f.service.infer(outsider.actor, f.input), { urgent: true });
 const [event] = await db.owner`select actor_id from audit_events where organisation_id = ${f.organisationId} and action = 'inference.usage_recorded' order by created_at desc limit 1`;
 assert.equal(event!.actorId, outsider.actor.userId);
});
it('HTTP routes require a session, validate input and return our inference errors', async () => {
 const f = await fixture();
 const { AuthService } = await import('../auth/service.ts'); const { createApp } = await import('../app.ts');
 const { OrganisationService } = await import('../organisations/service.ts'); const { CommitmentsService } = await import('../commitments/service.ts');
 const auth = new AuthService(db.app, null, { appUrl: 'http://localhost:3000', sessionTtlDays: 1 });
 const app = createApp({ db: db.app, auth, inference: f.service, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app) });
 const path = `/v1/organisations/${f.organisationId}/inference`;
 assert.equal((await app.request(path)).status, 401);
 const { token } = await auth.issueSessionFor(f.actor.userId); const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
 assert.equal((await app.request(path, { headers })).status, 200);
 assert.equal((await app.request(path + '/budget', { method: 'PATCH', headers, body: '{"limitTokens":-1}' })).status, 400);
 f.stub.responses.push(new InferenceError('needs_login'));
 const failed = await app.request(path + '/runtime/verify', { method: 'POST', headers }); assert.equal(failed.status, 503); assert.equal((await failed.json()).code, 'needs_login');
});
it('reserved API runtimes cannot call the Sprite provider', async () => {
 const f = await fixture(); await db.owner`update inference_runtimes set provider = 'anthropic_api' where organisation_id = ${f.organisationId}`;
 const calls = f.stub.requests.length;
 await assert.rejects(f.service.infer(f.actor, f.input), { code: 'runtime_not_ready' });
 await assert.rejects(f.service.verify(f.actor, f.organisationId), { code: 'runtime_not_ready' });
 assert.equal(f.stub.requests.length, calls);
});
it('setting up a subscription creates the Sprite through the API, moves to needs-sign-in once the shim answers, and disconnect destroys it', async () => {
 const suffix = randomBytes(6).toString('hex');
 const [org] = await db.owner`insert into organisations (name) values (${suffix}) returning id`;
 const [user] = await db.owner`insert into users (email) values (${suffix + '@example.com'}) returning id`;
 const organisationId = String(org!.id), actor = { userId: String(user!.id), requestId: suffix };
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${organisationId}, ${actor.userId}, 'owner')`;
 const stub = new StubProvider([]); let healthy = false; stub.health = async () => { if (!healthy) throw new InferenceError('runtime_not_ready'); };
 const sprites: { provisioned: string[]; destroyed: string[]; files: string[]; secret: string } = { provisioned: [], destroyed: [], files: [], secret: '' };
 const provisioner = {
  provision: async (name: string, files: Record<string, Buffer>) => { sprites.provisioned.push(name); sprites.files = Object.keys(files).sort(); sprites.secret = JSON.parse(files['runtime.json']!.toString()).secret; return { url: `https://${name}.sprites.app/`, region: 'syd' }; },
  destroy: async (name: string) => { sprites.destroyed.push(name); }
 };
 const service = new InferenceService(db.app, randomBytes(32), () => stub, provisioner);
 const requested = await service.request(actor, organisationId, 'codex');
 assert.equal(requested.runtime!.status, 'provisioning'); assert.equal(requested.runtime!.spriteName, `captain-${organisationId}`); assert.equal(requested.runtime!.region, 'syd');
 assert.deepEqual(sprites.provisioned, [`captain-${organisationId}`]); assert.match(sprites.secret, /^[a-f0-9]{64}$/);
 assert.deepEqual(sprites.files, ['bootstrap.sh', 'catalog.mjs', 'codex.toml', 'login.py', 'runtime.json', 'shim.mjs']);
 assert.equal((await service.get(actor, organisationId)).runtime!.status, 'provisioning');
 healthy = true;
 const state = await service.get(actor, organisationId); assert.equal(state.runtime!.status, 'needs_login'); assert.equal(state.spritesConfigured, true);
 assert.ok(!JSON.stringify(state).includes(sprites.secret));
 const [row] = await db.owner`select connection_encrypted from inference_runtimes where organisation_id = ${organisationId}`; assert.ok(row!.connectionEncrypted);
 // Not ready yet: setting up again reinstalls in place on the same Sprite.
 assert.equal((await service.request(actor, organisationId, 'codex')).runtime!.status, 'provisioning'); assert.equal(sprites.provisioned.length, 2);
 healthy = true; assert.equal((await service.get(actor, organisationId)).runtime!.status, 'needs_login');
 // Sign-in from Settings: start, read the state live, forward one code, never journal it.
 const started = await service.loginStart(actor, organisationId); assert.equal(started.state, 'waiting'); assert.equal(started.url, 'https://claude.ai/oauth/authorize?state=stub');
 const signing = await service.get(actor, organisationId); assert.equal(signing.login?.state, 'waiting'); assert.equal(signing.runtime!.loginUrl, 'https://claude.ai/oauth/authorize?state=stub');
 assert.equal((await service.loginCode(actor, organisationId, 'one-time#SECRET-CODE')).state, 'done'); assert.deepEqual(stub.codes, ['one-time#SECRET-CODE']);
 assert.equal((await service.get(actor, organisationId)).login?.state, 'done');
 assert.ok(!JSON.stringify(await db.owner`select * from audit_events where organisation_id = ${organisationId}`).includes('SECRET-CODE'));
 await service.remove(actor, organisationId); assert.deepEqual(sprites.destroyed, [`captain-${organisationId}`]);
 assert.equal((await service.get(actor, organisationId)).runtime!.status, 'removed');
 const events = await db.owner`select action, detail from audit_events where organisation_id = ${organisationId}`;
 assert.ok(!JSON.stringify(events).includes(sprites.secret));
 const failing = new InferenceService(db.app, randomBytes(32), () => stub, { provision: async () => { throw new SpritesError('write shim.mjs', 500); }, destroy: async () => {} });
 const [org2] = await db.owner`insert into organisations (name) values (${suffix + '-2'}) returning id`; const org2Id = String(org2!.id);
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${org2Id}, ${actor.userId}, 'owner')`;
 await assert.rejects(failing.request(actor, org2Id, 'claude'), { code: 'provisioning_failed' });
 const failedState = await failing.get(actor, org2Id); assert.equal(failedState.runtime!.status, 'failed'); assert.equal(failedState.runtime!.spriteName, `captain-${org2Id}`); assert.equal(failedState.runtime!.error, 'sprites_write_500');
 await assert.rejects(failing.loginStart(actor, org2Id), { code: 'runtime_not_ready' });
 // Set up again from Failed reuses the row; a provisioner that now works moves it on.
 const retry = new InferenceService(db.app, randomBytes(32), () => stub, provisioner);
 assert.equal((await retry.request(actor, org2Id, 'codex')).runtime!.status, 'provisioning');
 assert.equal(sprites.provisioned.at(-1), `captain-${org2Id}`);
 // Disconnect after a failure that never recorded a URL still destroys the Sprite by its name.
 await db.owner`update inference_runtimes set status = 'failed', sprite_name = null, connection_encrypted = null where organisation_id = ${org2Id}`;
 await retry.remove(actor, org2Id); assert.equal(sprites.destroyed.at(-1), `captain-${org2Id}`);
 const none = new InferenceService(db.app, randomBytes(32), () => stub, null);
 const byHand = await none.request(actor, org2Id, 'claude'); assert.equal(byHand.runtime!.status, 'provisioning'); assert.equal(byHand.runtime!.spriteName, null);
 assert.equal((await none.get(actor, org2Id)).spritesConfigured, false);
});

