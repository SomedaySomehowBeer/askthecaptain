import { apiUrl } from './env.ts';

export class ApiError extends Error {
	readonly status: number; readonly code: string; readonly requestId: string | null;
	constructor(status: number, code: string, message: string, requestId: string | null) { super(message); this.status = status; this.code = code; this.requestId = requestId; this.name = 'ApiError'; }
	get offline() { return this.status === 0; }
	get unauthorised() { return this.status === 401; }
}

export type Me = { user: { id: string; email: string; name: string }; memberships: Membership[] };
export type Membership = { organisationId: string; organisationName: string; role: Role; status: string };
export type Role = 'owner' | 'admin' | 'member';
export type Organisation = { id: string; name: string; timezone: string; locale: string; createdAt: string; role: Role };
export type Member = { userId: string; name: string; email: string; role: Role; status: string; since: string };
export type Invitation = { id: string; email: string; role: Exclude<Role, 'owner'>; invitedBy: string; expiresAt: string; createdAt: string };

/** One call to the API. Throws `ApiError` with the API's own code and message, or status 0 when the
 *  API could not be reached at all. */
export async function api<T>(path: string, options: { token?: string; method?: string; body?: unknown } = {}): Promise<T> {
	let response: Response;
	try {
		response = await fetch(new URL(path, apiUrl), { method: options.method ?? 'GET', cache: 'no-store',
			headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
			body: options.body === undefined ? undefined : JSON.stringify(options.body) });
	} catch { throw new ApiError(0, 'offline', 'Captain could not reach its API just now.', null); }
	if (!response.ok) {
		const detail = (await response.json().catch(() => ({}))) as { code?: string; error?: string };
		throw new ApiError(response.status, detail.code ?? 'error', detail.error ?? 'That did not work.', response.headers.get('x-request-id'));
	}
	return (await response.json()) as T;
}

export type Loaded<T> = { ok: true; value: T } | { ok: false; error: ApiError };
/** A read either answered or it did not; pages render the refusal as a designed state, not a throw. */
export async function load<T>(work: () => Promise<T>): Promise<Loaded<T>> {
	try { return { ok: true, value: await work() }; }
	catch (error) { return { ok: false, error: error instanceof ApiError ? error : new ApiError(0, 'unknown', 'That could not be read.', null) }; }
}
