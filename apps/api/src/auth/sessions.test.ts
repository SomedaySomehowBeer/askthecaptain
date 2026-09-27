import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import postgres, { type Sql } from 'postgres';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { RateLimiter } from '../ratelimit.ts';
import { AuthService, hashSecret, sessionLockName } from './service.ts';

// Sign out everywhere else, increment 1 of docs/plans/mobile-session-revocation-2026-09.md: real Postgres, the runtime
// role behind the API, and a separate owner pool that holds the person's lock and commits rows at chosen moments.
const it = databaseUrl ? test : test.skip;
type App = ReturnType<typeof createApp>;
let db: Harness; let side: Sql; let auth: AuthService; let app: App; let deps: Parameters<typeof createApp>[0];
/** Production limits unchanged. The limiter's clock moves 20 s per check and a revocation makes three (address,
 *  person, revocation), so one person's revocation window has always reset before their next call. */
let clock = Date.parse('2030-01-01T00:00:00Z');
const limiter = new RateLimiter(() => (clock += 20_000));

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	side = postgres(db.databaseUrl, { max: 4, transform: postgres.camel });
	auth = new AuthService(db.app, null, { appUrl: 'https://app.example.test', sessionTtlDays: 30 });
	deps = { db: db.app, auth, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: limiter };
	app = createApp(deps);
});
after(async () => { await side?.end(); await db?.close(); });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const revoke = async (target: App, token: string, body?: unknown): Promise<Response> => target.request('/v1/me/sessions/revoke-others', {
	method: 'POST', headers: { ...bearer(token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
	body: body === undefined ? undefined : JSON.stringify(body)
});
const me = async (token: string) => (await app.request('/v1/me', { headers: bearer(token) })).status;
/** The middleware's 401 body, which the recheck's refusal must equal. */
const unauthorisedBody = { ok: false, code: 'unauthorised', error: 'sign in to continue' };

/** A 200's `ended`: the only key, a non-negative safe integer. */
async function ended(response: Response): Promise<number> {
	const text = await response.text();
	assert.equal(response.status, 200, text);
	const body = JSON.parse(text) as Record<string, unknown>;
	assert.deepEqual(Object.keys(body), ['ended']);
	assert.ok(Number.isSafeInteger(body.ended) && (body.ended as number) >= 0, text);
	return body.ended as number;
}
async function refused(response: Response) {
	assert.equal(response.status, 401, await response.clone().text());
	assert.deepEqual(await response.json(), unauthorisedBody);
}

let people = 0;
async function person(): Promise<string> {
	people += 1;
	const [user] = await db.owner`insert into users (email, name) values (${`revoke-${people}-${randomBytes(3).toString('hex')}@example.com`}, ${`Person ${people}`}) returning id`;
	return String(user!.id);
}
const issue = async (userId: string) => { const { token, session } = await auth.issueSessionFor(userId); return { token, id: session.id }; };
const row = async (id: string) => (await db.owner<{ revokedAt: Date | null; expiresAt: Date }[]>`select revoked_at, expires_at from sessions where id = ${id}`)[0]!;
const events = (userId: string) => db.owner<{ success: boolean; detail: unknown }[]>`select success, detail from auth_events
	where event = 'auth.sessions.revoke_others' and user_id = ${userId} order by created_at, id`;

/** This person's revocation lock, held in an open transaction on its own connection until `release()`. */
async function holdLock(userId: string) {
	const connection = await side.reserve();
	await connection`begin`;
	await connection`select pg_advisory_xact_lock(hashtextextended(${sessionLockName(userId)}, 0))`;
	return { async release() { await connection`commit`; connection.release(); } };
}
/** How many calls Postgres itself shows queued behind that exact lock in this database. */
const waiting = async (userId: string) => Number((await side`select count(*)::int as n from pg_locks l, (select hashtextextended(${sessionLockName(userId)}, 0) as k) h
	where l.locktype = 'advisory' and not l.granted and l.objsubid = 1 and l.database = (select oid from pg_database where datname = current_database())
	and l.classid::bigint = ((h.k >> 32) & 4294967295) and l.objid::bigint = (h.k & 4294967295)`)[0]!.n);
async function untilQueued(userId: string, count: number, settled: () => boolean) {
	for (let i = 0; (await waiting(userId)) < count; i++) {
		assert.ok(i < 200 && !settled(), 'the call never queued behind the person\'s lock');
		await sleep(25);
	}
}
/** A request whose settling is observable, so a wait can fail fast if it answered without queueing. */
function started(response: Promise<Response>) {
	const call = { settled: false, response: Promise.resolve(response).then((r) => { call.settled = true; return r; }) };
	return call;
}

/** Everything the API writes to the console while `work` runs. */
async function captured<T>(work: () => Promise<T>): Promise<{ value: T; text: string }> {
	const lines: string[] = [];
	const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
	const keep = (...args: unknown[]) => { lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
	Object.assign(console, { log: keep, info: keep, warn: keep, error: keep });
	try { return { value: await work(), text: lines.join('\n') }; } finally { Object.assign(console, saved); }
}

it('ends the other live sessions, keeps the current one, counts only active ones, and touches nobody else', async () => {
	const alice = await person(); const bob = await person();
	const current = await issue(alice); const phone = await issue(alice); const laptop = await issue(alice);
	const expired = await issue(alice); await db.owner`update sessions set expires_at = now() - interval '1 hour' where id = ${expired.id}`;
	const signedOut = await issue(alice); await db.owner`update sessions set revoked_at = '2029-01-01T00:00:00Z' where id = ${signedOut.id}`;
	const bobs = await issue(bob);

	const { value: response, text: logs } = await captured(() => revoke(app, current.token));
	const body = await response.clone().text();
	assert.equal(await ended(response), 2, 'the phone and the laptop; not the expired or already signed-out session');

	assert.equal(await me(current.token), 200, 'the calling session still works');
	for (const other of [phone, laptop]) { assert.equal(await me(other.token), 401); assert.ok((await row(other.id)).revokedAt); }
	assert.ok((await row(expired.id)).revokedAt, 'an expired session is revoked too, but not counted');
	assert.equal((await row(signedOut.id)).revokedAt!.toISOString(), '2029-01-01T00:00:00.000Z', 'an earlier sign-out keeps its time');
	assert.equal((await row(bobs.id)).revokedAt, null); assert.equal(await me(bobs.token), 200, 'another person is untouched');

	const recorded = await events(alice);
	assert.deepEqual(recorded.map((e) => [e.success, e.detail]), [[true, { ended: 2 }]], 'one event, holding a count only');
	assert.equal((await events(bob)).length, 0);

	// No token or stored hash in the response, the event or anything written to the console.
	const hashes = (await db.owner<{ tokenHash: string }[]>`select token_hash from sessions where user_id in (${alice}, ${bob})`).map((r) => r.tokenHash);
	for (const [where, text] of [['response', body], ['event', JSON.stringify(recorded)], ['logs', logs]] as const) {
		assert.doesNotMatch(text, /sess_/, where);
		for (const hash of hashes) assert.ok(!text.includes(hash), `${where} contains a stored hash`);
	}
});

it('repeats act on what each call sees: nothing new ends 0, a session made in between is ended', async () => {
	const alice = await person();
	const current = await issue(alice); await issue(alice);
	assert.equal(await ended(await revoke(app, current.token)), 1);
	assert.equal(await ended(await revoke(app, current.token)), 0);
	const later = await issue(alice);
	assert.equal(await ended(await revoke(app, current.token)), 1);
	assert.ok((await row(later.id)).revokedAt);
	assert.equal(await me(current.token), 200);
	assert.deepEqual((await events(alice)).map((e) => e.detail), [{ ended: 1 }, { ended: 0 }, { ended: 1 }]);
});

it('takes no input: a body naming another person or session changes nothing about whose sessions end', async () => {
	const alice = await person(); const bob = await person();
	const current = await issue(alice); const other = await issue(alice); const bobs = await issue(bob);
	assert.equal(await ended(await revoke(app, current.token, { userId: bob, sessionId: bobs.id, id: current.id, ended: 99 })), 1);
	assert.equal(await me(current.token), 200);
	assert.ok((await row(other.id)).revokedAt);
	assert.equal((await row(bobs.id)).revokedAt, null); assert.equal(await me(bobs.token), 200);
});

it('a missing, signed-out or expired calling session is refused by the middleware: same 401, no event, nothing ended', async () => {
	const alice = await person();
	const signedOut = await issue(alice); const expired = await issue(alice); const other = await issue(alice);
	await db.owner`update sessions set revoked_at = now() where id = ${signedOut.id}`;
	await db.owner`update sessions set expires_at = now() - interval '1 second' where id = ${expired.id}`;
	for (const token of [signedOut.token, expired.token]) await refused(await revoke(app, token));
	await refused(await app.request('/v1/me/sessions/revoke-others', { method: 'POST' }));
	assert.equal((await row(other.id)).revokedAt, null);
	assert.equal((await events(alice)).length, 0, 'the middleware records no event, as on every signed-in route');
});

it('expired while queued on the lock: refused at statement time, the failure event commits, nothing is ended', async () => {
	const alice = await person();
	const current = await issue(alice); const other = await issue(alice);
	const lock = await holdLock(alice);
	let call: ReturnType<typeof started> | undefined;
	try {
		call = started(revoke(app, current.token));
		const queued = call;
		await untilQueued(alice, 1, () => queued.settled);
		// The queued transaction, and so its now(), began before this; its recheck statement begins after the release.
		// With now() the recheck would pass; with statement_timestamp() it must not.
		await side`update sessions set expires_at = clock_timestamp() where id = ${current.id}`;
	} finally { await lock.release(); }
	await refused(await call!.response);
	assert.equal((await row(other.id)).revokedAt, null, 'nothing ended');
	assert.deepEqual((await events(alice)).map((e) => [e.success, e.detail]), [[false, { reason: 'current_session_ended' }]],
		'exactly one failure event, committed although the call was refused');
});

it('counts at statement time: a session that expired while the call queued is revoked but not counted', async () => {
	const alice = await person();
	const current = await issue(alice); const lapsed = await issue(alice); const live = await issue(alice);
	const lock = await holdLock(alice);
	let call: ReturnType<typeof started> | undefined;
	try {
		call = started(revoke(app, current.token));
		const queued = call;
		await untilQueued(alice, 1, () => queued.settled);
		await side`update sessions set expires_at = clock_timestamp() where id = ${lapsed.id}`;
	} finally { await lock.release(); }
	assert.equal(await ended(await call!.response), 1, 'only the session still active when the revoking statement ran');
	assert.ok((await row(lapsed.id)).revokedAt); assert.ok((await row(live.id)).revokedAt);
	assert.equal(await me(current.token), 200);
});

it('two of one person\'s sessions at once: the lock orders them, the first ends the second, which is refused', async () => {
	const alice = await person();
	const a = await issue(alice); const b = await issue(alice); const c = await issue(alice);
	const lock = await holdLock(alice);
	let calls: ReturnType<typeof started>[] = [];
	try {
		calls = [started(revoke(app, a.token)), started(revoke(app, b.token))];
		await untilQueued(alice, 2, () => calls.some((call) => call.settled));
	} finally { await lock.release(); }
	const [first, second] = await Promise.all(calls.map((call) => call.response));
	assert.deepEqual([first!.status, second!.status].sort(), [200, 401]);
	const aWon = first!.status === 200;
	const winner = aWon ? a : b; const loser = aWon ? b : a;
	assert.equal(await ended(aWon ? first! : second!), 2, 'the other caller and the third session');
	await refused(aWon ? second! : first!);
	assert.equal(await me(winner.token), 200); assert.equal(await me(loser.token), 401); assert.equal(await me(c.token), 401);
	const recorded = (await events(alice)).map((e) => [e.success, e.detail]);
	assert.deepEqual(recorded.sort((x, y) => Number(y[0]) - Number(x[0])), [[true, { ended: 2 }], [false, { reason: 'current_session_ended' }]]);
});

it('cutoff: a session committed while the call queues is ended; one committing after the revoking statement survives', async () => {
	const alice = await person();
	const current = await issue(alice);
	const lock = await holdLock(alice);
	const inFlight = await side.reserve();
	let call: ReturnType<typeof started> | undefined; let late: string | undefined; let queuedSession: { id: string } | undefined;
	try {
		try {
			call = started(revoke(app, current.token));
			const queued = call;
			await untilQueued(alice, 1, () => queued.settled);
			queuedSession = await issue(alice); // committed before the revoking statement begins: visible to it
			// A sign-in still in flight: its session is inserted now but commits only after the call has answered.
			await inFlight`begin`;
			const [inserted] = await inFlight<{ id: string }[]>`insert into sessions (user_id, token_hash, expires_at)
				values (${alice}, ${hashSecret(`sess_${randomBytes(32).toString('base64url')}`)}, now() + interval '1 day') returning id`;
			late = inserted!.id;
		} finally { await lock.release(); }
		assert.equal(await ended(await call!.response), 1, 'only the session committed while queued');
	} finally {
		await inFlight`commit`.catch(() => undefined); inFlight.release();
	}
	assert.ok((await row(queuedSession!.id)).revokedAt, 'committed while queued: ended');
	assert.equal((await row(late!)).revokedAt, null, 'committed after the revoking statement: survives (not an account lockout)');
});

it('people are separate: another person\'s held lock does not delay this call, and neither side\'s sessions move', async () => {
	const alice = await person(); const bob = await person();
	const aliceCurrent = await issue(alice); const aliceOther = await issue(alice);
	const bobCurrent = await issue(bob); const bobOther = await issue(bob);
	const lock = await holdLock(alice);
	try {
		assert.equal(await ended(await revoke(app, bobCurrent.token)), 1, 'answered while Alice\'s lock is held');
	} finally { await lock.release(); }
	assert.ok((await row(bobOther.id)).revokedAt);
	assert.equal((await row(aliceOther.id)).revokedAt, null); assert.equal(await me(aliceCurrent.token), 200);
	assert.equal((await events(alice)).length, 0);
});

it('five a minute per person, for that write only: the sixth is 429 with Retry-After and records no event', async () => {
	const limited = createApp({ ...deps, rateLimiter: new RateLimiter(() => 0) });
	const alice = await person(); const bob = await person();
	const current = await issue(alice); const bobs = await issue(bob);
	for (let i = 0; i < 5; i++) assert.equal(await ended(await revoke(limited, current.token)), 0);
	const sixth = await revoke(limited, current.token);
	assert.equal(sixth.status, 429); assert.ok(Number(sixth.headers.get('retry-after')) >= 1);
	assert.equal(((await sixth.json()) as { code: string }).code, 'rate_limited');
	assert.equal((await events(alice)).length, 5, 'no event for the refused sixth');
	assert.equal((await limited.request('/v1/me', { headers: bearer(current.token) })).status, 200, 'other routes keep their own budget');
	assert.equal(await ended(await revoke(limited, bobs.token)), 0, 'another person has their own budget');
});
