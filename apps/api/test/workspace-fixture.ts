import { writeFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { freshDatabase } from '../../../packages/db/test/harness.ts';
import { createApp } from '../src/app.ts';
import type { IdentityProvider } from '../src/auth/google.ts';
import type { TaskStatus } from '../src/commitments/service.ts';
import { AuthService } from '../src/auth/service.ts';
import { OrganisationService } from '../src/organisations/service.ts';
import { CommitmentsService } from '../src/commitments/service.ts';
import { NotesService } from '../src/notes/service.ts';
import { serve } from '@hono/node-server';
// Manual browser fixture only: never imported by the application or started against hosted data.
const directory = process.env.WORKSPACE_PROBE_DIR;
if (!directory)
    throw new Error('Set WORKSPACE_PROBE_DIR to a private temporary directory.');
if (!process.env.DATABASE_URL)
    throw new Error('DATABASE_URL is required');
const databaseHost = new URL(process.env.DATABASE_URL).hostname;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(databaseHost))
    throw new Error('The browser fixture requires a loopback Postgres server.');
const db = await freshDatabase();
try {
    type Identity = { subject: string; email: string; name: string };
    type SignedIn = { token: string; user: { id: string } };
    type Identified = { id: string };
    const google: IdentityProvider & {
        next: Identity;
    } = { next: { subject: 'workspace-owner', email: 'olive@example.test', name: 'Olive Owner' }, authorizationUrl: ({ state }) => `https://google.test/?state=${state}`, async exchange() { return this.next; } };
    const app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'http://127.0.0.1:3034', sessionTtlDays: 1 }), organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), notes: new NotesService(db.app) });
    async function request<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
        const response = await app.request(path, {
            method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${JSON.stringify(data)}`);
        return data as T;
    }
    async function login(): Promise<SignedIn> {
        const start = await app.request('/auth/google/start');
        const state = new URL(start.headers.get('location')!).searchParams.get('state');
        const callback = await app.request(`/auth/google/callback?code=test&state=${state}`);
        const code = new URL(callback.headers.get('location')!).searchParams.get('code');
        return request<SignedIn>('POST', '/auth/session/exchange', null, { code });
    }
    const owner = await login();
    const org = await request<Identified>('POST', '/v1/organisations', owner.token, { name: 'Workspace test bakery' });
    const base = `/v1/organisations/${org.id}`;
    const invitation = await request<{
        token: string;
    }>('POST', `${base}/invitations`, owner.token, { email: 'pat@example.test', role: 'member' });
    google.next = { subject: 'workspace-pat', email: 'pat@example.test', name: 'Pat Baker' };
    const pat = await login();
    await request('POST', '/v1/invitations/accept', pat.token, { token: invitation.token });
    const project = await request<Identified>('POST', `${base}/projects`, owner.token, { name: 'Autumn launch' });
    const production = await request<Identified>('POST', `${base}/tags`, owner.token, { name: 'Production' });
    const sales = await request<Identified>('POST', `${base}/tags`, owner.token, { name: 'Sales' });
    const tasks: Record<string, string> = {};
    const seeds: [string, TaskStatus, string | null, string | null][] = [
        ['Confirm packaging slot', 'open', owner.user.id, production.id],
        ['Call the stockist', 'open', pat.user.id, sales.id],
        ['Completed launch task', 'done', owner.user.id, null],
        ['Cancelled launch task', 'cancelled', owner.user.id, null],
        ['Unassigned launch task', 'open', null, null]
    ];
    for (const [title, status, who, tag] of seeds) {
        const task = await request<Identified>('POST', `${base}/tasks`, owner.token, { title, status, ownerId: who, projectId: project.id });
        tasks[title] = task.id;
        if (tag)
            await request('PUT', `${base}/tasks/${task.id}/tags/${tag}`, owner.token);
    }
    for (let i = 0; i < 50; i++)
        await request('POST', `${base}/tasks`, owner.token, { title: `Team follow-up ${i + 1}`, projectId: project.id, ownerId: pat.user.id });
    const equipment: { id: string; name: string }[] = [];
    for (const name of ['A Fermenter', 'B Canning line', 'C Bright tank', 'D Cold room', 'E Delivery van', 'F Room', 'G Keg washer', 'H Chiller', 'I Pilot kit'])
        equipment.push(await request('POST', `${base}/equipment`, owner.token, { name }));
    const booking = await request<Identified>('POST', `${base}/equipment/${equipment[0]!.id}/reservations`, owner.token, {
        id: randomUUID(), title: 'Multi-day lager', startsAt: '2030-10-01T01:00:00Z', endsAt: '2030-10-04T04:00:00Z', setupMinutes: 60, cleanupMinutes: 120,
        projectId: project.id, taskId: tasks['Confirm packaging slot'], ownerId: owner.user.id
    });
    await request('POST', `${base}/equipment/${equipment[1]!.id}/reservations`, owner.token, {
        id: randomUUID(), title: 'Line maintenance', kind: 'maintenance', startsAt: '2030-10-02T01:00:00Z', endsAt: '2030-10-02T02:00:00Z'
    });
    await writeFile(`${directory}/data.json`, JSON.stringify({ fixture: 'captain-workspace-local', token: owner.token, userId: owner.user.id, orgId: org.id, base, projectId: project.id, productionId: production.id, salesId: sales.id, tasks, equipment, bookingId: booking.id }), { mode: 0o600, flag: 'wx' });
    let mutationRequests = 0;
    const server = serve({ hostname: '127.0.0.1', port: 8084, fetch: async (req, bindings) => {
        const mode = await readFile(`${directory}/mode`, 'utf8').catch(() => '');
        const url = new URL(req.url);
        if (url.pathname === '/__fixture/stats') return Response.json({ mutationRequests });
        if (url.pathname.startsWith(base + '/') && !['GET', 'HEAD'].includes(req.method)) mutationRequests++;
        if (url.pathname === '/v1/me' && mode.startsWith('session-')) {
            if (mode === 'session-network') {
                // Drop the actual HTTP connection, rather than disguising a 503 as a network fault.
                bindings.outgoing.destroy();
                return new Response(null, { status: 503 });
            }
            const status = mode === 'session-expired' ? 401 : mode === 'session-rate-limited' ? 429 : 503;
            return Response.json({ code: 'fixture_session_failure', error: 'Fixture session lookup failed' }, { status, headers: status === 429 ? { 'retry-after': '1' } : {} });
        }

        if (mode === 'equipment-failed' && req.method === 'GET' && url.pathname.endsWith('/equipment'))
            return Response.json({ error: 'Fixture equipment unavailable' }, { status: 503 });
        if (mode === 'reservations-failed' && req.method === 'GET' && url.pathname.endsWith('/reservations'))
            return Response.json({ error: 'Fixture reservations unavailable' }, { status: 503 });
        if (mode === 'reservations-partial' && req.method === 'GET' && url.pathname.endsWith('/reservations')) {
            const result = await app.fetch(req); const value = await result.json() as Record<string, unknown>;
            return Response.json({ ...value, coverage: 'partial', nextOffset: 200 }, { status: result.status });
        }
        if (mode === 'equipment-lookups-failed' && req.method === 'GET' && (url.pathname.endsWith('/members') || url.pathname.endsWith('/commitments')))
            return Response.json({ error: 'Fixture choices unavailable' }, { status: 503 });
        if (mode === 'equipment-zone-sydney' && req.method === 'GET' && url.pathname === base) {
            const result = await app.fetch(req); const value = await result.json() as Record<string, unknown>;
            return Response.json({ ...value, timezone: 'Australia/Sydney' }, { status: result.status });
        }
        if (mode === 'reservation-save-uncertain' && req.method === 'POST' && url.pathname.endsWith('/reservations')) {
            await app.fetch(req); // Commit the real booking, then simulate losing only the response.
            return Response.json({ error: 'Fixture lost save response' }, { status: 503 });
        }
        if (mode === 'reservation-save-failed' && req.method === 'POST' && url.pathname.endsWith('/reservations'))
            return Response.json({ error: 'Fixture did not reach booking handler' }, { status: 503 });
        if (req.method === 'GET' && url.pathname.endsWith('/tasks') && mode === 'failed')
            return Response.json({ error: 'Fixture task query unavailable' }, { status: 503 });
        if (mode === 'tags-failed' && req.method === 'GET' && (url.pathname.endsWith('/tags') || url.pathname.endsWith('/tag-options')))
            return Response.json({ error: 'Fixture tag query unavailable' }, { status: 503 });
        if (mode === 'tag-write-failed' && req.method !== 'GET' && url.pathname.includes('/tags'))
            return Response.json({ error: 'Fixture tag write unavailable' }, { status: 503 });
        return app.fetch(req);
    } });
    console.log('Workspace fixture ready on 8084');
    async function close() { server.close(); await db.close(); await unlink(`${directory}/data.json`); process.exit(0); }
    process.on('SIGTERM', close);
    process.on('SIGINT', close);
}
catch (error) {
    await db.close();
    throw error;
}
