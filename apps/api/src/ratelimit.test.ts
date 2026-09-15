import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { RateLimiter, policies, rateLimit } from './ratelimit.ts';
import { HttpError } from './errors.ts';

test('a fixed window counts hits, refuses past the limit, and resets', () => {
	let now = 1_000_000; const limiter = new RateLimiter(() => now);
	for (let i = 0; i < 3; i += 1) assert.equal(limiter.hit('k', 3, 60_000).allowed, true);
	const refused = limiter.hit('k', 3, 60_000);
	assert.equal(refused.allowed, false); assert.equal(refused.remaining, 0); assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60);
	assert.equal(limiter.hit('other', 3, 60_000).allowed, true, 'keys are independent');
	now += 60_001;
	assert.equal(limiter.hit('k', 3, 60_000).allowed, true, 'the window reset');
	now += 120_000; limiter.hit('fresh', 1, 60_000);
	assert.ok(limiter.size <= 2, 'expired windows are pruned');
});

test('policies key by client ip, session user, organisation and expensive triggers', async () => {
	let now = 0; const limiter = new RateLimiter(() => now); const p = policies();
	const app = new Hono<{ Variables: { session?: { userId: string } } }>();
	app.use('/auth/*', rateLimit(limiter, { ...p.auth, limit: 2 }));
	app.use('/v1/*', async (c, next) => { c.set('session', { userId: 'u1' }); await next(); });
	app.use('/v1/*', rateLimit(limiter, { ...p.user, limit: 5 }, { ...p.organisation, limit: 4 }, { ...p.trigger, limit: 1 }));
	app.get('/auth/providers', (c) => c.json({ ok: true }));
	app.get('/v1/organisations/:id/commitments', (c) => c.json({ ok: true }));
	app.post('/v1/organisations/:id/mail/sync', (c) => c.json({ ok: true }));
	app.onError((error, c) => error instanceof HttpError ? c.json({ code: error.code, error: error.message }, error.status as 429) : c.json({}, 500));
	const org = '00000000-0000-7000-8000-000000000001';
	const ip = (address: string) => ({ headers: { 'fly-client-ip': address } });
	assert.equal((await app.request('/auth/providers', ip('1.1.1.1'))).status, 200);
	assert.equal((await app.request('/auth/providers', ip('1.1.1.1'))).status, 200);
	const third = await app.request('/auth/providers', ip('1.1.1.1'));
	assert.equal(third.status, 429); assert.ok(third.headers.get('retry-after')); assert.match(((await third.json()) as { error: string }).error, /sign-in attempts/);
	assert.equal((await app.request('/auth/providers', ip('2.2.2.2'))).status, 200, 'another address has its own budget');
	assert.equal((await app.request(`/v1/organisations/${org}/mail/sync`, { method: 'POST' })).status, 200);
	const trigger = await app.request(`/v1/organisations/${org}/mail/sync`, { method: 'POST' });
	assert.equal(trigger.status, 429); assert.match(((await trigger.json()) as { error: string }).error, /syncs and connection attempts/);
	assert.equal((await app.request(`/v1/organisations/${org}/commitments`)).status, 200);
	assert.equal((await app.request(`/v1/organisations/${org}/commitments`)).status, 200);
	assert.equal((await app.request(`/v1/organisations/${org}/commitments`)).status, 429, 'the organisation budget of 4 is spent by the two syncs and two reads');
	now += 60_001;
	assert.equal((await app.request(`/v1/organisations/${org}/commitments`)).status, 200);
});
