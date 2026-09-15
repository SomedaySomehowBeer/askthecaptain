import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { InferenceError } from '@captain/model';
import { fixture, database } from '../../../../packages/engine/test/fixture.ts';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { WorkflowService } from './service.ts';
const it = process.env.DATABASE_URL ? test : test.skip;
it('manual run, Resume and Cancel routes enforce management roles and tenant boundaries', async () => {
 const db = await database(); const f = await fixture(db);
 try {
  const auth = new AuthService(db.app, null, { appUrl: 'http://localhost:3000', sessionTtlDays: 1 });
  const workflows = new WorkflowService(db.app, null, f.engine); await workflows.sync();
  const app = createApp({ db: db.app, auth, workflows, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app) });
  const base = `/v1/organisations/${f.organisationId}/workflows`;
  const session = await auth.issueSessionFor(f.userId);
  const request = (path: string, token = session.token) => app.request(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal((await app.request(base + '/inbox-triage/run', { method: 'POST' })).status, 401);
  const [member, outsider] = await db.owner`insert into users (email) values (${randomUUID() + '@test.invalid'}), (${randomUUID() + '@test.invalid'}) returning id`;
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${f.organisationId}, ${member!.id}, 'member')`;
  const memberSession = await auth.issueSessionFor(String(member!.id)), outsiderSession = await auth.issueSessionFor(String(outsider!.id));
  for (const path of ['/inbox-triage/run', `/runs/${randomUUID()}/resume`, `/runs/${randomUUID()}/cancel`]) {
   assert.equal((await request(path, memberSession.token)).status, 403); assert.equal((await request(path, outsiderSession.token)).status, 404);
  }
  f.provider.responses.unshift(new InferenceError('budget_spent'));
  const started = await request('/inbox-triage/run'); assert.equal(started.status, 202); const { runId } = await started.json();
  const until = async (state: string) => { for (let i = 0; i < 100; i++) { if ((await f.state(runId)).state === state) return; await delay(100); } assert.fail(`No ${state} run`); };
  await until('paused'); assert.equal((await request(`/runs/${runId}/resume`)).status, 200); await until('waiting');
  assert.equal((await request(`/runs/${runId}/cancel`)).status, 200); assert.equal((await f.state(runId)).state, 'cancelled');
  assert.equal((await request(`/runs/${runId}/resume`)).status, 400);
  assert.equal((await request(`/runs/${randomUUID()}/cancel`)).status, 404);
  await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status) values (${f.organisationId}, 'google', ${f.userId}, 'fixture@example.test', '{}', 'connected')`;
  await workflows.enable(f.actor, f.organisationId, 'inbox-triage', { enabled: true });
  assert.ok((await f.engine.boss.getSchedules()).some(s => s.key === `${f.enablementId}_1`));
  await workflows.enable(f.actor, f.organisationId, 'inbox-triage', { enabled: false });
  assert.ok(!(await f.engine.boss.getSchedules()).some(s => s.key === `${f.enablementId}_1`));
  await f.engine.close(); assert.equal((await request('/inbox-triage/run')).status, 400);
 } finally { await f.engine.close(); await db.close(); }
});
