import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { definitionByKey } from '@captain/steps';
import { briefFixture } from '../../test/brief-fixture.ts';
import { result, until } from '../../test/triage-fixture.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { OrganisationService } from '../organisations/service.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
it('the real runner saves a validated local-date brief, audits it and pushes the enabling person; replay does not duplicate inference or writes', async () => {
 const f = await briefFixture(db); try {
  assert.deepEqual(f.registry.missing(definitionByKey('morning-brief')!), []);
  await f.enable(); f.provider.responses.push(result(f.output));
  const [scheduled] = await f.tx(tx => tx`select id from workflow_runs where definition_key = 'morning-brief' and schedule_key is not null and state = 'queued'`);
  const run = String(scheduled!.id); await f.engine.boss.send('workflow_morning-brief', { runId: run });
  await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'succeeded');
  const latest = await f.briefs.latest(f.member, f.org, null); assert.equal(latest.brief!.forDate, f.clock.today); assert.equal(latest.notice, null);
  assert.equal(latest.brief!.title, f.output.title); assert.equal(latest.brief!.items.length, 4); assert.ok(latest.brief!.producedAt);
  const input = f.provider.requests.at(-1)!; assert.match(input.instruction, /UNTRUSTED DATA/); assert.match(input.input, /untrustedContent/);
  assert.ok(!JSON.stringify(input.input).includes('PRIVATE')); assert.ok(!JSON.stringify(input.input).includes('fixture-token'));
  assert.match(input.input, /"period":"overdue"/); assert.match(input.input, /"period":"today"/); assert.match(input.input, /"period":"suggested"/);
  assert.equal(f.payloads.length, 1); assert.equal(f.payloads[0]!.endpoint, 'https://push.example.test/owner'); assert.equal(f.payloads[0]!.payload.title, f.output.title); assert.equal(f.payloads[0]!.payload.url, '/');
  const [audit] = await f.tx(tx => tx`select actor_kind, actor_id from audit_events where action = 'brief.produced'`); assert.equal(audit!.actorKind, 'workflow'); assert.equal(audit!.actorId, f.userId);
  const requests = f.provider.requests.length; await f.engine.boss.send('workflow_morning-brief', { organisationId: f.org, runId: run });
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(f.provider.requests.length, requests); assert.equal(f.payloads.length, 1); assert.equal((await f.tx(tx => tx`select * from briefs`)).length, 1);
 } finally { await f.engine.close(); }
});
it('optional connections, incomplete caches and bounded lists stay explicit; a device belonging to someone else is insufficient', async () => {
 const f = await briefFixture(db); try {
  await f.push.unsubscribe(f.actor, f.org, 'https://push.example.test/owner');
  await f.push.subscribe(f.member, f.org, { endpoint: 'https://push.example.test/member', keys: { p256dh: 'fixture', auth: 'fixture' } });
  await assert.rejects(f.enable(), { code: 'requirements_unmet' });
  assert.deepEqual((await f.workflows.list(f.actor, f.org)).find(w => w.definition.key === 'morning-brief')!.unmet.map(u => u.requirement), ['push']);
  await f.push.subscribe(f.actor, f.org, { endpoint: 'https://push.example.test/owner', keys: { p256dh: 'fixture', auth: 'fixture' } });
  await f.tx(tx => tx`update connections set status = 'disconnected'`); await f.enable();
  f.provider.responses.push(result({ title: 'Your morning brief', lines: ['Check your commitments.'], items: [] }));
  const run = await f.start(); await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'succeeded');
  const latest = await f.briefs.latest(f.actor, f.org, null); assert.match(latest.brief!.lines.join(' '), /Xero is not connected/); assert.match(latest.brief!.lines.join(' '), /Google calendar is not connected/);
  const input = JSON.parse(f.provider.requests.at(-1)!.input.split('<untrusted_data>\n')[1]!.split('\n</untrusted_data>')[0]!); assert.equal(input.untrustedContent.receivables.connected, false); assert.deepEqual(input.untrustedContent.receivables.invoices, []);
  await f.tx(tx => tx`update connections set status = 'connected'`);
  await f.tx(tx => tx`insert into audit_events (organisation_id, actor_kind, action, subject_type, subject_id, detail) select ${f.org}, 'system', 'xero.sync_failed', 'connection', id, '{"error":"Fixture sync failure"}' from connections where provider = 'xero'`);
  await f.tx(tx => tx`update calendars set synced_to = now() - interval '1 day'`);
  await f.tx(tx => tx`insert into tasks (organisation_id, project_id, title, status, due, source_kind, created_by) select ${f.org}, project_id, 'Extra task ' || n, 'open', '2020-01-02', 'person', ${f.userId} from tasks cross join generate_series(1, 101) n where id = ${f.overdue.id}`);
  f.provider.responses.push(result({ title: 'Check the gaps', lines: ['Check your commitments.'], items: [] }));
  const next = await f.start(); await until(() => f.workflows.run(f.actor, f.org, next), r => r.state === 'succeeded');
  const partial = (await f.briefs.latest(f.actor, f.org, null)).brief!; assert.match(partial.lines.join(' '), /Calendar data may be incomplete/); assert.match(partial.lines.join(' '), /Xero data may be incomplete/); assert.match(partial.lines.join(' '), /first 100/);
 } finally { await f.engine.close(); }
});
it('invalid references are retried before persistence; spent budget pauses; failed push preserves the brief and retries with one tag', async () => {
 const f = await briefFixture(db); try {
  await f.enable(); await f.inference.setBudget(f.actor, f.org, 0); const run = await f.start();
  await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'paused'); assert.equal((await f.briefs.latest(f.actor, f.org, null)).brief, null);
  assert.match((await f.briefs.latest(f.actor, f.org, null)).notice!, /paused/);
  f.provider.responses.push(result({ ...f.output, items: [{ kind: 'task', id: randomUUID() }] }), result(f.output));
  await f.inference.setBudget(f.actor, f.org, 1_000_000); f.failPush(true);
  await f.tx(tx => f.engine.control(tx, f.org, run, 'resume'));
  await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'failed', 20000);
  const latest = await f.briefs.latest(f.actor, f.org, null); assert.equal(latest.brief!.title, f.output.title); assert.match(latest.notice!, /failed/);
  assert.equal((await f.tx(tx => tx`select * from briefs`)).length, 1); assert.ok(f.payloads.length >= 2); assert.equal(new Set(f.payloads.map(p => p.payload.tag)).size, 1);
  assert.equal((await f.tx(tx => tx`select * from model_usage where run_id = ${run}`)).length, 2);
  await f.tx(tx => tx`update briefs set for_date = for_date - 1`); const old = await f.briefs.latest(f.actor, f.org, null); assert.notEqual(old.brief!.forDate, old.today);
 } finally { await f.engine.close(); }
});
it('briefs enforce tenant RLS and composite run keys, and the HTTP reader requires membership', async () => {
 const f = await briefFixture(db); try {
  await f.enable(); f.provider.responses.push(result(f.output)); const run = await f.start(); await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'succeeded');
  const [other] = await db.owner`insert into organisations (name) values ('Other tenant') returning id`;
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${other!.id}, ${f.userId}, 'owner')`;
  const otherTx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, { organisationId: String(other!.id), userId: f.userId }, fn);
  assert.equal((await otherTx(tx => tx`select * from briefs`)).length, 0);
  assert.equal((await otherTx(tx => tx`update briefs set title = 'stolen' returning *`)).length, 0);
  await assert.rejects(otherTx(tx => tx`insert into briefs (organisation_id, run_id, for_date, title, lines, items) values (${f.org}, ${run}, current_date, 'bad', '[]', '[]')`), { code: '42501' });
  await assert.rejects(otherTx(tx => tx`insert into briefs (organisation_id, run_id, for_date, title, lines, items) values (${other!.id}, ${run}, current_date, 'bad', '[]', '[]')`), { code: '23503' });
  const [rls] = await db.owner`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'briefs'`; assert.ok(rls!.relrowsecurity && rls!.relforcerowsecurity);
  const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 });
  const app = createApp({ db: db.app, auth, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), workflows: f.workflows });
  const path = `/v1/organisations/${f.org}/briefs/latest`; assert.equal((await app.request(path)).status, 401);
  const stranger = await auth.issueSessionFor(f.stranger.userId), member = await auth.issueSessionFor(f.member.userId);
  assert.equal((await app.request(path, { headers: { authorization: `Bearer ${stranger.token}` } })).status, 404);
  const response = await app.request(path, { headers: { authorization: `Bearer ${member.token}` } }); assert.equal(response.status, 200); assert.equal((await response.json()).brief.title, f.output.title);
  await db.owner`update memberships set status = 'removed' where organisation_id = ${f.org} and user_id = ${f.userId}`;
  assert.equal((await f.tx(tx => tx`update briefs set title = 'revoked write' returning *`)).length, 0);
 } finally { await f.engine.close(); }
});
