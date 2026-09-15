import { createHash, randomBytes } from 'node:crypto';
import { GoogleConnector, GoogleError, googleScopes, type GoogleTokens } from '@captain/connectors';
import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { hashSecret } from '../auth/service.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { newDataKey, open, seal } from './encryption.ts';

type Actor = { userId: string; requestId: string };
export type Connection = { id: string; provider: string; connectedBy: string; accountEmail: string; scopes: string[];
	status: 'connected' | 'refresh_failed' | 'revoked' | 'disconnected'; error: string | null; updatedAt: Date };
type Stored = Connection & { accessTokenEncrypted: Buffer | null; refreshTokenEncrypted: Buffer | null; accessTokenExpiresAt: Date | null };
const statePayload = z.object({ organisationId: z.string().uuid(), verifier: z.string().min(1) });
const fields = ['access_token', 'refresh_token'] as const;

export class ConnectionService {
	readonly #db: Sql; readonly #google: GoogleConnector | null; readonly #master: Buffer | null; readonly #appUrl: string;
	constructor(db: Sql, google: GoogleConnector | null, master: Buffer | null, appUrl: string) {
		this.#db = db; this.#google = google; this.#master = master; this.#appUrl = appUrl;
	}
	get available() { return Boolean(this.#google && this.#master); }

	async list(actor: Actor, organisationId: string): Promise<{ connections: Connection[]; googleAvailable: boolean }> {
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.role(tx, actor, organisationId, false);
			const connections = await tx<Connection[]>`select id, provider, connected_by, account_email, scopes, status, error, updated_at from connections order by created_at`;
			return { connections, googleAvailable: this.available };
		});
	}
	async start(actor: Actor, organisationId: string): Promise<string> {
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.role(tx, actor, organisationId);
			if (!this.available) throw badRequest('google_unavailable', 'Google connections are not configured. Ask the owner to finish setup.');
			const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(32).toString('base64url');
			const [request] = await tx`insert into auth_requests (kind, token_hash, user_id, payload, expires_at)
				values ('google_connection', ${hashSecret(state)}, ${actor.userId}, ${tx.json({ organisationId, verifier })}, ${new Date(Date.now() + 15 * 60_000)}) returning id`;
			await this.journal(tx, actor, organisationId, 'connection.started', 'auth_request', request!.id);
			return this.#google!.authorizationUrl({ state, codeChallenge: createHash('sha256').update(verifier).digest('base64url') });
		});
	}
	async finish(code: string, state: string, providerError: string | undefined, requestId: string): Promise<string> {
		const target = new URL('/settings/connections', this.#appUrl);
		try {
			// Separate kind prevents a sign-in state from becoming a connection grant (and vice versa).
			const request = await this.#db.begin(async (tx) => {
				const [row] = await tx<{ id: string; userId: string; payload: unknown }[]>`update auth_requests set consumed_at = now()
					where kind = 'google_connection' and token_hash = ${hashSecret(state)} and consumed_at is null and expires_at > now() returning id, user_id, payload`;
				if (!row) return null;
				const payload = statePayload.parse(row.payload);
				await tx`select set_config('app.organisation_id', ${payload.organisationId}, true)`;
				await this.journal(tx, { userId: row.userId, requestId }, payload.organisationId, 'connection.callback_consumed', 'auth_request', row.id);
				return { ...payload, userId: row.userId };
			});
			if (!request) { target.searchParams.set('error', 'request_invalid'); return target.toString(); }
			if (providerError) { target.searchParams.set('error', 'access_denied'); return target.toString(); }
			if (!this.available) { target.searchParams.set('error', 'google_unavailable'); return target.toString(); }
			const actor = { userId: request.userId, requestId }; const organisationId = request.organisationId;
			await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
				await this.role(tx, actor, organisationId);
				if (!code) throw badRequest('google_failed', 'Google did not return a code');
				const tokens = await this.#google!.exchange({ code, codeVerifier: request.verifier });
				const scopes = tokens.scopes ?? googleScopes; // OAuth omission means the requested scopes were granted.
				if (!googleScopes.slice(2).every((scope) => scopes.includes(scope))) throw badRequest('scopes_missing', 'Grant both Gmail and Calendar access.');
				const profile = await this.#google!.profile(tokens.accessToken);
				// Require a new offline grant; never reuse another account's old refresh token.
				if (!tokens.refreshToken) throw badRequest('refresh_missing', 'Google did not grant offline access. Reconnect and consent again.');
				const key = await this.dataKey(tx, actor, organisationId, true);
				const [row] = await tx`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status,
					access_token_encrypted, refresh_token_encrypted, access_token_expires_at)
					values (${organisationId}, 'google', ${actor.userId}, ${profile.emailAddress}, ${tx.array(scopes)}, 'connected',
						${seal(key, Buffer.from(tokens.accessToken), organisationId, fields[0])}, ${seal(key, Buffer.from(tokens.refreshToken), organisationId, fields[1])}, ${this.expiry(tokens)})
					on conflict (organisation_id, provider) do update set connected_by = excluded.connected_by, account_email = excluded.account_email,
						scopes = excluded.scopes, status = 'connected', error = null, access_token_encrypted = excluded.access_token_encrypted,
						refresh_token_encrypted = excluded.refresh_token_encrypted, access_token_expires_at = excluded.access_token_expires_at, updated_at = now() returning id`;
				await this.journal(tx, actor, organisationId, 'connection.connected', 'connection', row!.id);
			});
			target.searchParams.set('connected', 'google');
		} catch (error) {
			// Never put provider bodies, credentials or database errors in a URL or a log.
			const allowed = new Set(['forbidden', 'not_found', 'scopes_missing', 'refresh_missing']);
			const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
			target.searchParams.set('error', allowed.has(code) ? code : 'google_failed');
		}
		return target.toString();
	}
	async disconnect(actor: Actor, organisationId: string, connectionId: string): Promise<void> {
		await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.role(tx, actor, organisationId);
			const row = await this.lock(tx, connectionId);
			if (row.status === 'disconnected') return;
			let revoked = false;
			try {
				const key = await this.dataKey(tx, actor, organisationId);
				const encrypted = row.refreshTokenEncrypted ?? row.accessTokenEncrypted;
				if (this.#google && encrypted) {
					await this.#google.revoke(open(key, encrypted, organisationId, row.refreshTokenEncrypted ? fields[1] : fields[0]).toString()); revoked = true;
				}
			} catch { /* Best effort: local disconnection still clears credentials. */ }
			await tx`update connections set status = 'disconnected', error = ${revoked ? null : 'Google revocation could not be confirmed. Remove Captain in your Google account permissions.'},
				access_token_encrypted = null, refresh_token_encrypted = null, access_token_expires_at = null, updated_at = now() where id = ${connectionId}`;
			await this.journal(tx, actor, organisationId, 'connection.disconnected', 'connection', connectionId);
		});
	}
	/** API-only credential seam: pass undefined for a system routine, or an active member for a workflow.
	 * No token is exposed by an HTTP route; connect/disconnect still require an owner or admin.
	 * Failed refreshes commit their honest state before the error is raised to the caller. */
	async accessToken(actor: Actor | undefined, organisationId: string, connectionId: string): Promise<string> {
		const result = await withTenant(this.#db, { organisationId, userId: actor?.userId }, async (tx) => {
			if (actor) await this.role(tx, actor, organisationId, false);
			if (!this.available) throw badRequest('google_unavailable', 'Google connections are not configured.');
			const row = await this.lock(tx, connectionId);
			if (row.status === 'disconnected' || row.status === 'revoked') throw badRequest('reconnect_required', 'Reconnect Google in Settings.');
			const key = await this.dataKey(tx, actor, organisationId);
			if (row.accessTokenEncrypted && row.accessTokenExpiresAt && row.accessTokenExpiresAt.getTime() > Date.now() + 60_000)
				return { token: open(key, row.accessTokenEncrypted, organisationId, fields[0]).toString() };
			try {
				if (!row.refreshTokenEncrypted) throw new GoogleError('grant_revoked');
				const tokens = await this.#google!.refresh(open(key, row.refreshTokenEncrypted, organisationId, fields[1]).toString());
				if (tokens.scopes && !googleScopes.slice(2).every((scope) => tokens.scopes!.includes(scope))) throw new GoogleError('grant_revoked');
				await tx`update connections set access_token_encrypted = ${seal(key, Buffer.from(tokens.accessToken), organisationId, fields[0])},
					refresh_token_encrypted = ${tokens.refreshToken ? seal(key, Buffer.from(tokens.refreshToken), organisationId, fields[1]) : row.refreshTokenEncrypted},
					access_token_expires_at = ${this.expiry(tokens)}, scopes = ${tx.array(tokens.scopes ?? row.scopes)}, status = 'connected', error = null, updated_at = now() where id = ${connectionId}`;
				await this.journal(tx, actor, organisationId, 'connection.refreshed', 'connection', connectionId);
				return { token: tokens.accessToken };
			} catch (error) {
				const revoked = error instanceof GoogleError && error.code === 'grant_revoked';
				await tx`update connections set status = ${revoked ? 'revoked' : 'refresh_failed'},
					error = ${revoked ? 'Google access was revoked. Reconnect Google in Settings.' : 'Google could not refresh access. Try again or reconnect in Settings.'}, updated_at = now() where id = ${connectionId}`;
				await this.journal(tx, actor, organisationId, 'connection.refresh_failed', 'connection', connectionId);
				return { token: null };
			}
		});
		if (!result.token) throw badRequest('reconnect_required', 'Google access is unavailable. Try again or reconnect in Settings.');
		return result.token;
	}
	private async role(tx: TransactionSql, actor: Actor, organisationId: string, manage = true) {
		const [row] = await tx`select role from memberships where organisation_id = ${organisationId} and user_id = ${actor.userId} and status = 'active' for share`;
		if (!row) throw notFound();
		if (manage && row.role === 'member') throw forbidden('Only an owner or admin can manage connections.');
	}
	private async lock(tx: TransactionSql, id: string): Promise<Stored> {
		const [row] = await tx<Stored[]>`select * from connections where id = ${id} and provider = 'google' for update`;
		if (!row) throw notFound(); return row;
	}
	private async dataKey(tx: TransactionSql, actor: Actor | undefined, organisationId: string, create = false): Promise<Buffer> {
		if (!this.#master) throw badRequest('google_unavailable', 'Connection encryption is not configured.');
		// Creation locks the organisation so simultaneous first grants cannot overwrite its key.
		const rows = create ? await tx`select data_key_wrapped from organisations where id = ${organisationId} for update`
			: await tx`select data_key_wrapped from organisations where id = ${organisationId}`;
		const wrapped = rows[0]?.dataKeyWrapped as Buffer | null;
		if (wrapped) return open(this.#master, wrapped, organisationId, 'data_key');
		if (!create) throw new Error('organisation data key missing');
		const fresh = newDataKey(this.#master, organisationId);
		await tx`update organisations set data_key_wrapped = ${fresh.wrapped} where id = ${organisationId}`;
		await this.journal(tx, actor, organisationId, 'organisation.data_key_created', 'organisation', organisationId);
		return fresh.key;
	}
	private expiry(tokens: GoogleTokens) { return new Date(Date.now() + tokens.expiresIn * 1000); }
	private journal(tx: TransactionSql, actor: Actor | undefined, organisationId: string, action: string, subjectType: string, subjectId: string) {
		return audit(tx, { organisationId, actor: actor ? { kind: 'person', id: actor.userId } : { kind: 'system' }, requestId: actor?.requestId, action, subjectType, subjectId });
	}
}
