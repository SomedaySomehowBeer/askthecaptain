import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { freshDatabase } from '@captain/db/test';
import { stocktakeFixture } from '../../test/stocktake-fixture.ts';
import { until } from '../../test/workflow-fixture.ts';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
const it = process.env.DATABASE_URL ? test : test.skip;
it('manual run, Resume and Cancel enforce management roles and tenant boundaries for business workflows', async () => {
 const db = await freshDatabase(); const f = await stocktakeFixture(db);
 try {
  const auth = new AuthService(db.app, null, { appUrl: 'http://localhost:3000', sessionTtlDays: 1 });
  const app = createApp({ db: db.app, auth, workflows: f.workflows, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app) });
  const base = `/v1/organisations/${f.org}/workflows`;
  const [owner, member, outsider] = await Promise.all([f.userId, f.member.userId, f.stranger.userId].map(id => auth.issueSessionFor(id)));
  const request = (path: string, token = owner!.token) => app.request(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal((await app.request(base + '/stocktake/run', { method: 'POST' })).status, 401);
  for (const path of ['/stocktake/run', `/runs/${randomUUID()}/resume`, `/runs/${randomUUID()}/cancel`]) {
   assert.equal((await request(path, member!.token)).status, 403); assert.equal((await request(path, outsider!.token)).status, 404);
  }
  await f.stock.save(f.actor, f.org, { name: 'Malt', location: 'Store', unitLabel: 'bags' });
  const started = await request('/stocktake/run'); assert.equal(started.status, 202); const { runId } = await started.json();
  const state = () => f.workflows.run(f.actor, f.org, runId);
  await until(state, r => r.state === 'waiting');
  await f.tx(tx => tx`update workflow_runs set state = 'paused' where id = ${runId}`);
  assert.equal((await request(`/runs/${runId}/resume`)).status, 200); await until(state, r => r.state === 'waiting');
  assert.equal((await request(`/runs/${runId}/cancel`)).status, 200); assert.equal((await state()).state, 'cancelled');
  assert.equal((await request(`/runs/${runId}/resume`)).status, 400);
  assert.equal((await request(`/runs/${randomUUID()}/cancel`)).status, 404);
  const e = (await f.tx(tx => tx`select id from workflow_enablements where definition_key = 'stocktake'`))[0]!;
  assert.ok((await f.engine.boss.getSchedules()).some(s => s.key === `${e.id}_0`));
  await f.workflows.enable(f.actor, f.org, 'stocktake', { enabled: false, parameters: { location: 'Store' } });
  assert.ok(!(await f.engine.boss.getSchedules()).some(s => s.key === `${e.id}_0`));
  for (const key of ['inbox-triage','morning-brief','calendar-prep','discover-projects']) {
   assert.equal((await request(`/${key}/run`)).status, 400);
   await assert.rejects(f.workflows.enable(f.actor, f.org, key, { enabled: true }), { status: 404 });
  }
 } finally { await f.engine.close(); await db.close(); }
});
