import type { Context, MiddlewareHandler } from 'hono';
import { HttpError } from './errors.ts';

/** Fixed-window counters in this process (plan §9: limits per IP, user, organisation and
 *  connection). One machine serves the one environment (D17), so process memory is the right
 *  place today; a shared store is a swap of this class when there are several machines. Entries
 *  are pruned as they expire, so memory is bounded by the number of active keys per window. */
export class RateLimiter {
	readonly #windows = new Map<string, { count: number; resetAt: number }>();
	readonly #now: () => number;
	#lastPrune = 0;
	constructor(now: () => number = Date.now) { this.#now = now; }

	/** Counts one hit and says whether it is within the limit, and when the window resets. */
	hit(key: string, limit: number, windowMs: number): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
		const now = this.#now();
		if (now - this.#lastPrune > windowMs) { for (const [k, w] of this.#windows) if (w.resetAt <= now) this.#windows.delete(k); this.#lastPrune = now; }
		let window = this.#windows.get(key);
		if (!window || window.resetAt <= now) { window = { count: 0, resetAt: now + windowMs }; this.#windows.set(key, window); }
		window.count += 1;
		return { allowed: window.count <= limit, remaining: Math.max(0, limit - window.count), retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) };
	}
	get size() { return this.#windows.size; }
}

export class RateLimited extends HttpError {
	readonly retryAfterSeconds: number;
	constructor(retryAfterSeconds: number, what: string) { super(429, 'rate_limited', `too many ${what}; try again in ${retryAfterSeconds === 1 ? 'a second' : `${retryAfterSeconds} seconds`}`); this.retryAfterSeconds = retryAfterSeconds; this.name = 'RateLimited'; }
}

/** The client's address as the edge saw it: Fly sets `fly-client-ip`; behind any other proxy the
 *  first hop of `x-forwarded-for`; otherwise the socket, which Hono's node adapter does not expose,
 *  so `unknown` groups direct callers together. */
export const clientIp = (c: Context): string => c.req.header('fly-client-ip')?.trim() || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

export type Policy = { name: string; limit: number; windowMs: number; key: (c: Context) => string | null };

/** The default policies. Limits are per window; a policy whose key is null does not apply. */
export function policies(): Record<'ip' | 'auth' | 'webhook' | 'user' | 'organisation' | 'trigger', Policy> {
	const minute = 60_000;
	const organisationOf = (c: Context) => /^\/v1\/organisations\/([0-9a-f-]{36})(\/|$)/.exec(c.req.path)?.[1] ?? null;
	const trigger = /\/(mail|calendar|xero|shopify)\/sync$|\/connections\/[a-z]+\/start$|\/push\/test$|\/mail\/watch$|\/inference\/runtime(\/verify)?$|\/workflows\/[a-z0-9-]+\/run$/;
	return {
		ip: { name: 'requests', limit: 300, windowMs: minute, key: (c) => `ip:${clientIp(c)}` },
		auth: { name: 'sign-in attempts', limit: 30, windowMs: minute, key: (c) => `auth:${clientIp(c)}` },
		webhook: { name: 'webhook deliveries', limit: 600, windowMs: minute, key: (c) => `hook:${clientIp(c)}` },
		user: { name: 'requests', limit: 600, windowMs: minute, key: (c) => { const user = (c.get('session') as { userId?: string } | undefined)?.userId; return user ? `user:${user}` : null; } },
		organisation: { name: 'requests for this organisation', limit: 1200, windowMs: minute, key: (c) => { const org = organisationOf(c); return org ? `org:${org}` : null; } },
		trigger: { name: 'syncs and connection attempts', limit: 12, windowMs: minute, key: (c) => { const org = organisationOf(c); return org && c.req.method === 'POST' && trigger.test(c.req.path) ? `trigger:${org}` : null; } }
	};
}

/** Hono middleware applying one or more policies in order; the first exceeded one answers 429. */
export function rateLimit(limiter: RateLimiter, ...applied: Policy[]): MiddlewareHandler {
	return async (c, next) => {
		for (const policy of applied) {
			const key = policy.key(c); if (!key) continue;
			const result = limiter.hit(key, policy.limit, policy.windowMs);
			c.header('ratelimit-remaining', String(result.remaining));
			if (!result.allowed) { c.header('retry-after', String(result.retryAfterSeconds)); throw new RateLimited(result.retryAfterSeconds, policy.name); }
		}
		await next();
	};
}
