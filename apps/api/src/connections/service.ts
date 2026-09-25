import { GoogleConnector } from '@captain/connectors';
import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { audit } from '../audit.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { open } from './encryption.ts';

type Actor = { userId: string; requestId: string };
export type Connection = { id: string; provider: string; connectedBy: string; accountEmail: string | null; scopes: string[];
	status: 'connected' | 'refresh_failed' | 'revoked' | 'disconnected'; error: string | null; updatedAt: Date };
type Stored = Connection & { accessTokenEncrypted: Buffer | null; refreshTokenEncrypted: Buffer | null; accessTokenExpiresAt: Date | null };
const fields = ['access_token', 'refresh_token'] as const;

export class ConnectionService {
	readonly #db: Sql; readonly #google: GoogleConnector | null; readonly #master: Buffer | null;
	constructor(db: Sql, google: GoogleConnector | null, master: Buffer | null) {
		this.#db = db; this.#google = google; this.#master = master;
	}


	async list(actor: Actor, organisationId: string): Promise<{ connections: Connection[]; googleAvailable: boolean }> {
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.role(tx, actor, organisationId, false);
			const connections = await tx<Connection[]>`select id, provider, connected_by, account_email, scopes, status, error, updated_at from connections order by created_at`;
			return { connections, googleAvailable: false };
		});
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
	private async role(tx: TransactionSql, actor: Actor, organisationId: string, manage = true) {
		const [row] = await tx`select role from memberships where organisation_id = ${organisationId} and user_id = ${actor.userId} and status = 'active' for share`;
		if (!row) throw notFound();
		if (manage && row.role === 'member') throw forbidden('Only an owner or admin can manage connections.');
	}
	private async lock(tx: TransactionSql, id: string): Promise<Stored> {
		const [row] = await tx<Stored[]>`select * from connections where id = ${id} and provider = 'google' for update`;
		if (!row) throw notFound(); return row;
	}
	private async dataKey(tx: TransactionSql, _actor: Actor, organisationId: string): Promise<Buffer> {
  if (!this.#master) throw badRequest('google_unavailable', 'Connection encryption is not configured.');
  const [row] = await tx`select data_key_wrapped from organisations where id = ${organisationId}`;
  if (!row?.dataKeyWrapped) throw new Error('organisation data key missing');
  return open(this.#master, row.dataKeyWrapped, organisationId, 'data_key');
 }
	private journal(tx: TransactionSql, actor: Actor | undefined, organisationId: string, action: string, subjectType: string, subjectId: string) {
		return audit(tx, { organisationId, actor: actor ? { kind: 'person', id: actor.userId } : { kind: 'system' }, requestId: actor?.requestId, action, subjectType, subjectId });
	}
}
