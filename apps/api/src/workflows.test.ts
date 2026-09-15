import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { definitions } from '@captain/steps';
import { createApp } from './app.ts';
import type { IdentityProvider } from './auth/google.ts';
import { AuthService } from './auth/service.ts';
import { CommitmentsService } from './commitments/service.ts';
import { OrganisationService } from './organisations/service.ts';
import { WorkflowService } from './workflows/service.ts';

const it = databaseUrl ? test : test.skip;
let db: Harness; let app: ReturnType<typeof createApp>; let workflows: WorkflowService;
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`,
	async exchange() { return google.next; }
};
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
type Offered = { definition: { key: string }; unmet: { requirement: string }[]; enablement: { enabled: boolean; parameters: Record<string, unknown> } | null };

let owner: { token: string; user: { id: string } }; let orgId: string;
before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	workflows = new WorkflowService(db.app);
	app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }), organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), workflows });
	owner = await signIn({ subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' });
	orgId = (await body<{ id: string }>(await json('POST', '/v1/organisations', owner.token, { name: 'Harbour Brewing' }), 201)).id;
});
after(async () => { await db?.close(); });

it('the catalogue is synced from code, idempotently, and offered with what each workflow needs', async () => {
	assert.equal(await workflows.sync(), definitions.length);
	assert.equal(await workflows.sync(), definitions.length);
	const rows = await db.owner`select key, version, digest from workflow_definitions order by key`;
	assert.equal(rows.length, definitions.length);
	const offered = await body<{ workflows: Offered[] }>(await json('GET', `/v1/organisations/${orgId}/workflows`, owner.token), 200);
	assert.deepEqual(offered.workflows.map((w) => w.definition.key), definitions.map((d) => d.key));
	const triage = offered.workflows.find((w) => w.definition.key === 'inbox-triage')!;
	assert.deepEqual(triage.unmet.map((u) => u.requirement).sort(), ['connection:google', 'inference']);
	assert.equal(triage.enablement, null);
});

it('a workflow cannot be turned on until its requirements are met; parameters are saved either way', async () => {
	const refused = await json('PUT', `/v1/organisations/${orgId}/workflows/inbox-triage`, owner.token, { enabled: true, parameters: { replyStyle: 'Warm.' } });
	assert.equal(refused.status, 400); assert.match(((await refused.json()) as { error: string }).error, /needs a connected Google account and an inference runtime/);
	const saved = await body<{ enabled: boolean; parameters: Record<string, unknown> }>(await json('PUT', `/v1/organisations/${orgId}/workflows/inbox-triage`, owner.token, { enabled: false, parameters: { replyStyle: 'Warm.' } }), 200);
	assert.equal(saved.enabled, false); assert.deepEqual(saved.parameters, { replyStyle: 'Warm.', draftReplies: true });
	// Every shipped workflow needs inference, which has not shipped, so none can be turned on yet: the honest state.
	assert.equal((await json('PUT', `/v1/organisations/${orgId}/workflows/chase-due`, owner.token, { enabled: true, parameters: { windowDays: 10 } })).status, 400);
	const bad = await json('PUT', `/v1/organisations/${orgId}/workflows/stocktake`, owner.token, { enabled: false, parameters: { location: '', extra: 1 } });
	assert.equal(bad.status, 400); assert.match(((await bad.json()) as { error: string }).error, /location is required/);
	assert.equal((await json('PUT', `/v1/organisations/${orgId}/workflows/not-a-workflow`, owner.token, { enabled: false })).status, 404);
	const actions = (await db.owner`select action from audit_events where organisation_id = ${orgId} and subject_type = 'workflow_enablement'`).map((r) => r.action);
	assert.deepEqual(actions, ['workflow.disabled']);
});

it('members may read but not change; strangers see nothing; the journal is empty and says so', async () => {
	const member = await signIn({ subject: 'g-2', email: 'pat@example.com', name: 'Pat' });
	const invited = await body<{ token: string }>(await json('POST', `/v1/organisations/${orgId}/invitations`, owner.token, { email: 'pat@example.com', role: 'member' }), 201);
	await body(await json('POST', '/v1/invitations/accept', member.token, { token: invited.token }), 200);
	assert.equal((await json('GET', `/v1/organisations/${orgId}/workflows`, member.token)).status, 200);
	assert.equal((await json('PUT', `/v1/organisations/${orgId}/workflows/inbox-triage`, member.token, { enabled: false })).status, 403);
	const stranger = await signIn({ subject: 'g-3', email: 'sam@example.com', name: 'Sam' });
	assert.equal((await json('GET', `/v1/organisations/${orgId}/workflows`, stranger.token)).status, 404);
	const runs = await body<{ runs: unknown[] }>(await json('GET', `/v1/organisations/${orgId}/workflows/runs`, owner.token), 200);
	assert.deepEqual(runs.runs, []);
	assert.equal((await json('GET', `/v1/organisations/${orgId}/workflows/runs/00000000-0000-7000-8000-000000000000`, owner.token)).status, 404);
});
