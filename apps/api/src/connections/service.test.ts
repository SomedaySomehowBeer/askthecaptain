import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { GoogleConnector } from '@captain/connectors';
import { databaseUrl, freshDatabase } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { ConnectionService } from './service.ts';
import { newDataKey, seal } from './encryption.ts';
import { RateLimiter } from '../ratelimit.ts';
const it = databaseUrl ? test : test.skip;
it('retired routes refuse all access; Google identity survives and only an owner can revoke an existing mail grant', async () => {
 const db = await freshDatabase(); try {
  let calls = 0, clock = 0;
  const master = randomBytes(32);
  const connector = new GoogleConnector('client', 'secret', 'https://api.test/connections/google/callback', async url => { calls++; assert.match(String(url), /revoke/); throw Error('Provider unavailable'); });
  const connections = new ConnectionService(db.app, connector, master);
  const auth = new AuthService(db.app, { authorizationUrl: () => 'https://google.test/sign-in', exchange: async () => ({ subject: 'identity', email: 'id@example.test', name: 'Identity' }) }, { appUrl: 'https://app.test', sessionTtlDays: 1 });
  const app = createApp({ db: db.app, auth, connections, rateLimiter: new RateLimiter(() => clock += 60_001), organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app) });
  const [o] = await db.owner`insert into organisations (name) values ('Retirement') returning id`;
  const org = String(o!.id);
  const users = await db.owner`insert into users (email) values ('owner@test.com'), ('member@test.com'), ('stranger@test.com') returning id`;
  const owner = String(users[0]!.id), member = String(users[1]!.id);
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${owner}, 'owner'), (${org}, ${member}, 'member')`;
  const tokens = await Promise.all(users.map(u => auth.issueSessionFor(String(u.id))));
  const request = (path: string, method = 'GET', token?: string) => app.request(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const base = `/v1/organisations/${org}`;
  for (const [method, path] of [['GET','mail/threads'], ['GET',`mail/threads/${randomUUID()}`], ['POST','mail/sync'], ['POST','mail/watch'], ['POST',`mail/threads/${randomUUID()}/draft`], ['GET','calendar/events'], ['POST','calendar/sync'], ['GET','outbox'], ['POST',`outbox/${randomUUID()}/send`], ['GET','notes'], ['PUT',`notes/${randomUUID()}`], ['POST','answers'], ['GET','briefs/latest'], ['POST','discovery/requests'], ['POST',`projects/${randomUUID()}/accept`], ['POST','connections/google/start']]) {
   assert.equal((await request(`${base}/${path}`, method)).status, 401, path);
   assert.equal((await request(`${base}/${path}`, method, tokens[2]!.token)).status, 404, path);
   for (const session of tokens.slice(0,2)) {
    const result = await request(`${base}/${path}`, method, session.token);
    assert.equal(result.status, 410, path); assert.equal((await result.json()).code, 'legacy_feature_retired');
   }
  }
  assert.equal((await request('/connections/google/callback?code=private&state=old')).status, 410);
  assert.equal((await request('/webhooks/gmail', 'POST')).status, 410);
  assert.equal(calls, 0, 'retired routes never call a provider');
  assert.equal((await request('/auth/google/start')).status, 302);
  assert.deepEqual(await (await request('/auth/providers')).json(), { google: true });
  const key = newDataKey(master, org);
  await db.owner`update organisations set data_key_wrapped = ${key.wrapped} where id = ${org}`;
  const [grant] = await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, status, scopes, refresh_token_encrypted)
   values (${org}, 'google', ${owner}, 'old@example.test', 'connected', '{}', ${seal(key.key, Buffer.from('old-private-token'), org, 'refresh_token')}) returning id`;
  const metadata = await (await request(`${base}/connections`, 'GET', tokens[1]!.token)).json();
  assert.equal(metadata.googleAvailable, false); assert.equal(metadata.connections[0].status, 'connected'); assert.doesNotMatch(JSON.stringify(metadata), /old-private-token|Encrypted/);
  const revoke = `${base}/connections/${grant!.id}`;
  assert.equal((await request(revoke, 'DELETE', tokens[2]!.token)).status, 404);
  assert.equal((await request(revoke, 'DELETE', tokens[1]!.token)).status, 403);
  assert.equal((await request(revoke, 'DELETE', tokens[0]!.token)).status, 200);
  assert.equal(calls, 1);
  const [saved] = await db.owner`select status, refresh_token_encrypted, error from connections where id = ${grant!.id}`;
  assert.equal(saved!.status, 'disconnected'); assert.equal(saved!.refreshTokenEncrypted, null); assert.match(saved!.error, /could not be confirmed/);
  assert.equal((await db.owner`select id from audit_events where action = 'connection.disconnected'`).length, 1);
 } finally { await db.close(); }
});
