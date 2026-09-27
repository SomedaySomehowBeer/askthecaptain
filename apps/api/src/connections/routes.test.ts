import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { databaseUrl, freshDatabase } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { RateLimiter } from '../ratelimit.ts';
const it = databaseUrl ? test : test.skip;
it('retired routes refuse all access; the Google mailbox grant path is gone and Google identity survives', async () => {
 const db = await freshDatabase(); try {
  let clock = 0; let providerCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { providerCalls++; throw new Error('no provider may be called'); };
  const auth = new AuthService(db.app, { authorizationUrl: () => 'https://google.test/sign-in', exchange: async () => ({ subject: 'identity', email: 'id@example.test', name: 'Identity' }) }, { appUrl: 'https://app.test', sessionTtlDays: 1 });
  const app = createApp({ db: db.app, auth, rateLimiter: new RateLimiter(() => clock += 60_001), organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app) });
  const [o] = await db.owner`insert into organisations (name) values ('Retirement') returning id`;
  const org = String(o!.id);
  const users = await db.owner`insert into users (email) values ('owner@test.com'), ('member@test.com'), ('stranger@test.com') returning id`;
  const owner = String(users[0]!.id), member = String(users[1]!.id);
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${owner}, 'owner'), (${org}, ${member}, 'member')`;
  const tokens = await Promise.all(users.map(u => auth.issueSessionFor(String(u.id))));
  const request = (path: string, method = 'GET', token?: string) => app.request(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const base = `/v1/organisations/${org}`;
  try {
   // Retired roots, including the organisation-scoped Google start: unauthenticated 401, a stranger 404 (nothing
   // about the organisation leaks), members 410.
   for (const [method, path] of [['GET','mail/threads'], ['GET',`mail/threads/${randomUUID()}`], ['POST','mail/sync'], ['POST','mail/watch'], ['POST',`mail/threads/${randomUUID()}/draft`], ['GET','calendar/events'], ['POST','calendar/sync'], ['GET','outbox'], ['POST',`outbox/${randomUUID()}/send`], ['GET','notes'], ['PUT',`notes/${randomUUID()}`], ['POST','answers'], ['GET','briefs/latest'], ['POST','discovery/requests'], ['POST',`projects/${randomUUID()}/accept`], ['POST','connections/google/start']]) {
    assert.equal((await request(`${base}/${path}`, method)).status, 401, path);
    assert.equal((await request(`${base}/${path}`, method, tokens[2]!.token)).status, 404, path);
    for (const session of tokens.slice(0,2)) {
     const result = await request(`${base}/${path}`, method, session.token);
     assert.equal(result.status, 410, path); assert.equal((await result.json()).code, 'legacy_feature_retired');
    }
   }
   // A malformed organisation ID never reaches a 410 either.
   assert.equal((await request('/v1/organisations/not-a-uuid/connections/google/start', 'POST', tokens[0]!.token)).status, 400);
   assert.equal((await request('/connections/google/callback?code=private&state=old')).status, 410);
   assert.equal((await request('/webhooks/gmail', 'POST')).status, 410);

   // The mailbox grant list and disconnect routes no longer exist, even with a stored legacy row present.
   const [grant] = await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, status, scopes)
    values (${org}, 'google', ${owner}, 'old@example.test', 'disconnected', '{}') returning id`;
   for (const [method, path] of [['GET', `${base}/connections`], ['DELETE', `${base}/connections/${grant!.id}`]] as const) {
    assert.equal((await request(path, method)).status, 401, `${method} ${path} unauthenticated`);
    for (const session of tokens) {
     const result = await request(path, method, session.token);
     assert.equal(result.status, 404, `${method} ${path}`);
     assert.doesNotMatch(await result.text(), /old@example\.test/);
    }
   }
   const [kept] = await db.owner`select status, account_email from connections where id = ${grant!.id}`;
   assert.deepEqual({ ...kept }, { status: 'disconnected', accountEmail: 'old@example.test' }, 'nothing touches the stored row');
   assert.equal((await db.owner`select id from audit_events where action = 'connection.disconnected'`).length, 0);
   assert.equal(providerCalls, 0, 'retired and removed routes never call a provider');

   // Google identity sign-in is unchanged.
   assert.equal((await request('/auth/google/start')).status, 302);
   assert.deepEqual(await (await request('/auth/providers')).json(), { google: true });
  } finally { globalThis.fetch = realFetch; }
 } finally { await db.close(); }
});
