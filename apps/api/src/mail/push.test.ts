import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { after, before, test } from 'node:test';
import { GmailClient } from '@captain/connectors/gmail';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { HttpError } from '../errors.ts';
import { readEnv } from '../env.ts';
import { OrganisationService } from '../organisations/service.ts';
import { GooglePushVerifier } from './oidc.ts';
import { GmailPush, startGmailPushSchedule } from './push.ts';
import { GmailWatch } from './watch.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
const config = { topic: 'projects/project-test/topics/mail', audience: 'https://api.test/webhooks/gmail' };
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
function bearer() {
 const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
 const p = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: config.audience, email: 'gmail-pubsub@project-test.iam.gserviceaccount.com', email_verified: true, sub: '123', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
 return `Bearer ${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key.privateKey).toString('base64url')}`;
}
const envelope = (email: string, id = '123') => ({ message: { messageId: id, data: Buffer.from(JSON.stringify({ emailAddress: email, historyId: '9999999999999999999' })).toString('base64') }, subscription: 'projects/project-test/subscriptions/mail-push' });
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
async function setup() {
 const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 }); const organisations = new OrganisationService(db.app);
 const [owner, member, outsider] = await db.owner`insert into users (email) values (${`${randomUUID()}@test.com`}), (${`${randomUUID()}@test.com`}), (${`${randomUUID()}@test.com`}) returning id`;
 const a = await organisations.create({ userId: owner!.id, requestId: 'test' }, { name: 'A' }); const b = await organisations.create({ userId: outsider!.id, requestId: 'test' }, { name: 'B' });
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${a.id}, ${member!.id}, 'member')`;
 const email = `${randomUUID()}@business.test`; const emailB = `${randomUUID()}@business.test`;
 const [conn] = await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status) values (${a.id}, 'google', ${owner!.id}, ${email}, '{}', 'connected') returning id`;
 await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status) values (${b.id}, 'google', ${outsider!.id}, ${emailB}, '{}', 'connected')`;
 const calls: string[] = []; let held: Promise<void> | undefined; let failure = false; let busy = false; let watches = 0; let watchFailure = false; let time = Date.now();
 const sync = { async organisations() { return (await db.app`select organisation_id from gmail_sync_organisations()`).map((r) => r.organisationId as string); },
  async run(org: string) { calls.push(org); if (held) await held; if (busy) throw new HttpError(409, 'sync_running', 'busy'); if (failure) throw new Error('provider-private-body'); return { threads: 0, messages: 0, attachments: 0, deleted: 0, full: false, capped: false, resumed: 0 }; } };
 const verifier = new GooglePushVerifier(config.audience, 'gmail-pubsub@project-test.iam.gserviceaccount.com', async () => Response.json({ test: key.publicKey.export({ type: 'spki', format: 'pem' }) }, { headers: { 'cache-control': 'max-age=3600' } }));
 const push = new GmailPush(db.app, sync, config, verifier);
 const client = new GmailClient(async (url) => {
  if (String(url).endsWith('/profile')) return Response.json({ emailAddress: email, historyId: '100' });
  watches++; return watchFailure ? new Response('private-watch-error', { status: 500 }) : Response.json({ historyId: '999', expiration: String(time + 7 * 86_400_000) });
 });
 const watch = new GmailWatch(db.app, { async accessToken() { return 'fixture-token'; } }, config, client, () => time);
 const app = createApp({ db: db.app, auth, organisations, commitments: new CommitmentsService(db.app), gmailPush: push, gmailWatch: watch, mailScheduleEnabled: true });
 const tokens = { owner: (await auth.issueSessionFor(owner!.id)).token, member: (await auth.issueSessionFor(member!.id)).token, outsider: (await auth.issueSessionFor(outsider!.id)).token };
 const request = (body: unknown, authorization = bearer()) => app.request('/webhooks/gmail', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
 const watchRequest = (role: keyof typeof tokens = 'owner', method = 'POST') => app.request(`/v1/organisations/${a.id}/mail/watch`, { method, headers: { authorization: `Bearer ${tokens[role]}` } });
 return { a: a.id, b: b.id, conn: conn!.id, email, emailB, request, watchRequest, calls, push, watch, owner: owner!.id,
  hold: (p?: Promise<void>) => { held = p; }, fail: (value: boolean) => { failure = value; }, busy: (value: boolean) => { busy = value; }, watchFail: (value: boolean) => { watchFailure = value; }, watches: () => watches, advance: (ms: number) => { time += ms; } };
}
it('valid push returns 204 before sync completes, deduplicates messageId, and journals the right tenant', { timeout: 10000 }, async () => {
 const s = await setup(); let release!: () => void; s.hold(new Promise<void>((r) => { release = r; }));
 try {
  assert.equal((await s.request(envelope(s.email, '1001'))).status, 204);
  assert.equal((await s.request(envelope(s.email, '1001'))).status, 204);
  for (let n = 0; n < 100 && !s.calls.length; n++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(s.calls, [s.a]);
  assert.equal((await db.owner`select id from webhook_events where organisation_id = ${s.a}`).length, 1);
  assert.equal((await db.owner`select id from webhook_events where organisation_id = ${s.b}`).length, 0);
  assert.equal((await db.app`select id from webhook_events`).length, 0);
  assert.equal((await withTenant(db.app, { organisationId: s.b }, (tx) => tx`select id from webhook_events`)).length, 0);
 } finally { release(); await s.push.idle(); }
 const [event] = await db.owner`select processed_at, payload from webhook_events where organisation_id = ${s.a}`; assert.ok(event!.processedAt); assert.equal(event!.payload.historyId, '9999999999999999999');
 const [attempt] = await db.owner`select completed_at, error from webhook_attempts where organisation_id = ${s.a}`; assert.ok(attempt!.completedAt); assert.equal(attempt!.error, null);
});
it('invalid JWT/body is rejected; unknown, disconnected and ambiguous accounts do nothing', async () => {
 const s = await setup(); assert.equal((await s.request(envelope(s.email), 'Bearer invalid')).status, 401);
 assert.equal((await s.request({ message: { messageId: 'x', data: 'bad' } })).status, 400);
 assert.equal((await s.request(envelope('unknown@example.test'))).status, 204);
 assert.equal((await s.request({ huge: 'x'.repeat(20000) })).status, 413);
 await db.owner`update connections set account_email = ${s.email} where organisation_id = ${s.b}`;
 assert.equal((await s.request(envelope(s.email))).status, 204);
 await db.owner`update connections set status = 'disconnected' where organisation_id in (${s.a}, ${s.b})`;
 assert.equal((await s.request(envelope(s.email))).status, 204); await s.push.idle(); assert.equal(s.calls.length, 0);
 assert.equal((await db.owner`select id from webhook_events where organisation_id in (${s.a}, ${s.b})`).length, 0);
});
it('failures and overlap leave durable receipts; retry recovers and does not expose provider errors', async () => {
 const s = await setup(); s.fail(true); await s.request(envelope(s.email, '2001')); await s.push.idle();
 let [event] = await db.owner`select processed_at from webhook_events where organisation_id = ${s.a}`; assert.equal(event!.processedAt, null);
 s.fail(false); s.busy(true); s.push.enqueue(s.a); await s.push.idle(); s.busy(false); s.push.enqueue(s.a); await s.push.idle();
 [event] = await db.owner`select processed_at from webhook_events where organisation_id = ${s.a}`; assert.ok(event!.processedAt);
 const attempts = await db.owner`select error from webhook_attempts where organisation_id = ${s.a} order by attempted_at, id`;
 assert.equal(attempts.length, 3); assert.match(attempts[1]!.error, /already running/); assert.equal(attempts[2]!.error, null); assert.ok(!JSON.stringify(attempts).includes('provider-private'));
});
it('mail arriving during a sync gets a follow-up pass; a replaced account receipt is retired', async () => {
 const s = await setup(); let release!: () => void; s.hold(new Promise<void>((r) => { release = r; }));
 await s.request(envelope(s.email, '3001'));
 for (let n = 0; n < 100 && !s.calls.length; n++) await new Promise((r) => setTimeout(r, 5));
 await s.request(envelope(s.email, '3002')); release(); await s.push.idle(); assert.equal(s.calls.length, 2);
 s.fail(true); await s.request(envelope(s.email, '3003')); await s.push.idle(); const before = s.calls.length;
 await db.owner`update connections set account_email = 'replacement@example.test' where id = ${s.conn}`;
 s.push.enqueue(s.a); await s.push.idle(); assert.equal(s.calls.length, before);
 assert.equal((await db.owner`select id from webhook_events where organisation_id = ${s.a} and processed_at is null`).length, 0);
});
it('watch is owner/admin only, renews daily as system, reports failures, and never moves history', async () => {
 const s = await setup();
 await db.owner`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${s.a}, ${s.conn}, 'gmail.history', 'original')`;
 assert.equal((await s.watchRequest('member')).status, 403); assert.equal((await s.watchRequest('outsider')).status, 404);
 assert.equal((await s.watchRequest()).status, 200); assert.equal(s.watches(), 1);
 assert.equal((await (await s.watchRequest('member', 'GET')).json()).status, 'active');
 await s.watch.renew(s.a, undefined, true); assert.equal(s.watches(), 1);
 s.advance(86_400_001); await s.watch.renew(s.a, undefined, true); assert.equal(s.watches(), 2);
 const [cursor] = await db.owner`select cursor from sync_cursors where organisation_id = ${s.a} and resource = 'gmail.history'`; assert.equal(cursor!.cursor, 'original');
 const audit = await db.owner`select actor_kind from audit_events where organisation_id = ${s.a} and action = 'mail.watch_renewed' order by created_at, id`;
 assert.deepEqual(audit.map((a) => a.actorKind), ['person', 'system']);
 s.watchFail(true); assert.equal((await s.watchRequest()).status, 503); const state = await (await s.watchRequest('member', 'GET')).json(); assert.equal(state.status, 'failed'); assert.ok(!JSON.stringify(state).includes('private-watch'));
});
it('maintenance starts watches, recovers durable receipts, and disabled configuration starts nothing', async () => {
 const s = await setup(); s.fail(true); await s.request(envelope(s.email, '4001')); await s.push.idle(); s.fail(false);
 // Restrict this maintenance fixture to its organisation, as other tests seed unrelated accounts.
 s.push.sync.organisations = async () => [s.a];
 const stop = startGmailPushSchedule(s.push, s.watch, 10000);
 for (let n = 0; n < 100 && s.calls.length < 2; n++) await new Promise((r) => setTimeout(r, 10));
 await stop(); assert.equal(s.watches(), 1); assert.equal(s.calls.length, 2);
 const [event] = await db.owner`select processed_at from webhook_events where organisation_id = ${s.a}`; assert.ok(event!.processedAt);
 const before = s.watches(); await startGmailPushSchedule(undefined, s.watch, 5)(); assert.equal(s.watches(), before);
});
test('push config is optional and paired, with a fully qualified topic', () => {
 const base = { DATABASE_URL: 'test', APP_URL: 'https://app.test', API_URL: 'https://api.test' };
 assert.equal(readEnv(base).GMAIL_PUBSUB_TOPIC, undefined);
 assert.throws(() => readEnv({ ...base, GMAIL_PUBSUB_TOPIC: config.topic }));
 assert.throws(() => readEnv({ ...base, GMAIL_PUBSUB_TOPIC: 'bad-topic', GMAIL_PUSH_AUDIENCE: config.audience }));
 assert.equal(readEnv({ ...base, GMAIL_PUBSUB_TOPIC: config.topic, GMAIL_PUSH_AUDIENCE: config.audience }).GMAIL_PUBSUB_TOPIC, config.topic);
});
