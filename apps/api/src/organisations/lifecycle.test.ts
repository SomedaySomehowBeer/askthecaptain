import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import type { IdentityProvider } from '../auth/google.ts';
import { AuthService } from '../auth/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationLifecycle } from './lifecycle.ts';
import { OrganisationService } from './service.ts';

const it = databaseUrl ? test : test.skip;
let db: Harness; let app: ReturnType<typeof createApp>;
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`,
	async exchange() { return google.next; }
};
const revoked: string[] = [];
const json = (method: string, path: string, token?: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
async function signIn(identity: { subject: string; email: string; name: string }) {
	google.next = identity;
	const start = await app.request('/auth/google/start');
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
	const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
	const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
	return (await (await json('POST', '/auth/session/exchange', undefined, { code })).json()) as { token: string; user: { id: string } };
}
const body = async <T>(response: Response, status: number): Promise<T> => { assert.equal(response.status, status, await response.clone().text()); return (await response.json()) as T; };

let owner: { token: string; user: { id: string } }; let orgId: string; let otherOrgId: string;
before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	const lifecycle = new OrganisationLifecycle(db.app, [async (_actor, organisationId) => { revoked.push(organisationId); }]);
	app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }), organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), lifecycle });
	owner = await signIn({ subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' });
	orgId = (await body<{ id: string }>(await json('POST', '/v1/organisations', owner.token, { name: 'Harbour Brewing' }), 201)).id;
	otherOrgId = (await body<{ id: string }>(await json('POST', '/v1/organisations', owner.token, { name: 'Other Place' }), 201)).id;
	await body(await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: 'Send price list' }), 201);
	await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status, access_token_encrypted) values (${orgId}, 'google', ${owner.user.id}, 'owner@example.com', '{}', 'connected', ${Buffer.from('secret')})`;
});
after(async () => { await db?.close(); });

it('the export streams every tenant table as newline-delimited JSON, without secret columns', async () => {
	const response = await json('GET', `/v1/organisations/${orgId}/export`, owner.token);
	assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /x-ndjson/);
	const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
	const header = lines[0]!; const footer = lines[lines.length - 1]!;
	assert.equal(header.kind, 'captain-export'); assert.equal((header.organisation as { name: string }).name, 'Harbour Brewing');
	assert.ok((header.tables as string[]).includes('tasks') && (header.tables as string[]).includes('connections') && (header.tables as string[]).includes('audit_events'));
	const rows = lines.slice(1, -1) as { table: string; row: Record<string, unknown> }[];
	assert.equal(rows.filter((r) => r.table === 'tasks').length, 1);
	assert.equal(rows.filter((r) => r.table === 'projects').length, 0, 'no project is created for the organisation or its task');
	assert.equal(rows.find((r) => r.table === 'tasks')!.row.projectId, null);
	const connection = rows.find((r) => r.table === 'connections')!;
	assert.equal(connection.row.provider, 'google'); assert.ok(!('accessTokenEncrypted' in connection.row) && !('refreshTokenEncrypted' in connection.row) && !Object.keys(connection.row).some((k) => /Encrypted$/.test(k)), 'tokens never leave');
	assert.ok(rows.every((r) => r.row.organisationId === orgId), 'only this organisation');
	assert.equal((footer.counts as Record<string, number>).tasks, 1);
	const audit = await db.owner`select action from audit_events where organisation_id = ${orgId} and action = 'organisation.exported'`;
	assert.equal(audit.length, 1);
	const stranger = await signIn({ subject: 'g-9', email: 'sam@example.com', name: 'Sam' });
	assert.equal((await json('GET', `/v1/organisations/${orgId}/export`, stranger.token)).status, 404);
});

it('deletion needs the owner and the exact name, revokes providers, records the fact, and leaves other organisations alone', async () => {
	assert.equal((await json('DELETE', `/v1/organisations/${orgId}`, owner.token, { name: 'harbour brewing' })).status, 400);
	const member = await signIn({ subject: 'g-2', email: 'pat@example.com', name: 'Pat' });
	const invited = await body<{ token: string }>(await json('POST', `/v1/organisations/${orgId}/invitations`, owner.token, { email: 'pat@example.com', role: 'admin' }), 201);
	await body(await json('POST', '/v1/invitations/accept', member.token, { token: invited.token }), 200);
	assert.equal((await json('DELETE', `/v1/organisations/${orgId}`, member.token, { name: 'Harbour Brewing' })).status, 403, 'an admin cannot delete');
	const result = await body<{ name: string; rowCounts: Record<string, number> }>(await json('DELETE', `/v1/organisations/${orgId}`, owner.token, { name: 'Harbour Brewing' }), 200);
	assert.equal(result.name, 'Harbour Brewing'); assert.equal(result.rowCounts.tasks, 1); assert.equal(result.rowCounts.memberships, 2);
	assert.deepEqual(revoked, [orgId]);
	assert.equal((await db.owner`select id from organisations where id = ${orgId}`).length, 0);
	for (const table of ['tasks', 'projects', 'memberships', 'connections', 'audit_events', 'invitations']) assert.equal((await db.owner.unsafe(`select 1 from ${table} where organisation_id = $1`, [orgId])).length, 0, table);
	const [record] = await db.owner`select name, deleted_by_email, row_counts from organisation_deletions where deleted_organisation_id = ${orgId}`;
	assert.equal(record!.name, 'Harbour Brewing'); assert.equal(record!.deletedByEmail, 'owner@example.com'); assert.equal((record!.rowCounts as Record<string, number>).tasks, 1);
	assert.equal((await json('GET', `/v1/organisations/${orgId}`, owner.token)).status, 404);
	const me = await body<{ memberships: { organisationId: string }[] }>(await json('GET', '/v1/me', owner.token), 200);
	assert.deepEqual(me.memberships.map((m) => m.organisationId), [otherOrgId], 'the other organisation and the person remain');
});
