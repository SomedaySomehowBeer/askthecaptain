import { withTenant, type Sql } from '@captain/db';
import { audit } from '../audit.ts';
import { badRequest, forbidden } from '../errors.ts';
import { canManage, roleOf, type Actor } from '../tenant.ts';

/** Columns that never leave the database, whatever table they are in: encrypted provider tokens and
 *  sprite secrets, device keys, token hashes. An export is the business's data, not its credentials. */
const secretColumns = new Set(['access_token_encrypted', 'refresh_token_encrypted', 'connection_encrypted', 'p256dh', 'auth', 'token_hash', 'pending_encrypted', 'data_key_wrapped']);
const identifier = /^[a-z_][a-z0-9_]*$/;

export type TenantTable = { name: string; columns: string[] };
export type Revoker = (actor: Actor, organisationId: string) => Promise<void>;

/** Export and deletion as first-class operations (plan §9). Export streams every tenant table the
 *  database knows about, discovered from the catalogue at request time so a new table is never
 *  forgotten, read under the tenant's own row security. Deletion revokes what it can at providers,
 *  records the fact on the platform, and lets the foreign keys take everything else with the row. */
export class OrganisationLifecycle {
	readonly #db: Sql; readonly #revokers: Revoker[];
	constructor(db: Sql, revokers: Revoker[] = []) { this.#db = db; this.#revokers = revokers; }

	async tables(): Promise<TenantTable[]> {
		const rows = await this.#db<{ table: string; column: string }[]>`select c.table_name as "table", c.column_name as "column" from information_schema.columns c
			join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
			where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.table_name <> 'organisations'
			and exists (select 1 from information_schema.columns o where o.table_schema = 'public' and o.table_name = c.table_name and o.column_name = 'organisation_id')
			order by c.table_name, c.ordinal_position`;
		const tables = new Map<string, string[]>();
		for (const row of rows) { if (!identifier.test(row.table) || !identifier.test(row.column) || secretColumns.has(row.column)) continue; tables.set(row.table, [...(tables.get(row.table) ?? []), row.column]); }
		return [...tables].map(([name, columns]) => ({ name, columns }));
	}

	/** Newline-delimited JSON: a header line, then one line per row `{ table, row }`, then a footer
	 *  with counts. Each table is read in its own tenant transaction so a large mailbox streams. */
	async *export(actor: Actor, organisationId: string): AsyncGenerator<string> {
		const role = await roleOf(this.#db, actor.userId, organisationId);
		if (!canManage(role)) throw forbidden('only an owner or admin can export the organisation');
		const tables = await this.tables();
		const organisation = await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [org] = await tx<{ id: string; name: string; timezone: string; locale: string; createdAt: Date }[]>`select id, name, timezone, locale, created_at from organisations where id = ${organisationId}`;
			await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, action: 'organisation.exported', subjectType: 'organisation', subjectId: organisationId, requestId: actor.requestId, detail: { tables: tables.map((t) => t.name) } });
			return org!;
		});
		yield JSON.stringify({ kind: 'captain-export', version: 1, exportedAt: new Date().toISOString(), keys: 'camelCase, as the API returns them', organisation, tables: tables.map((t) => t.name) }) + '\n';
		const counts: Record<string, number> = {};
		for (const table of tables) {
			const rows = await withTenant(this.#db, { organisationId, userId: actor.userId }, (tx) => tx.unsafe(`select ${table.columns.map((c) => `"${c}"`).join(', ')} from "${table.name}" where organisation_id = $1`, [organisationId]));
			counts[table.name] = rows.length;
			for (const row of rows) yield JSON.stringify({ table: table.name, row }) + '\n';
		}
		yield JSON.stringify({ kind: 'captain-export-end', counts }) + '\n';
	}

	/** Gone for good. The owner types the organisation's name; providers are told to revoke what they
	 *  can; the platform keeps a record; the row and everything under it are deleted. */
	async delete(actor: Actor & { email: string }, organisationId: string, confirmName: string): Promise<{ name: string; rowCounts: Record<string, number> }> {
		const role = await roleOf(this.#db, actor.userId, organisationId);
		if (role !== 'owner') throw forbidden('only an owner can delete the organisation');
		const [org] = await withTenant(this.#db, { organisationId, userId: actor.userId }, (tx) => tx<{ name: string }[]>`select name from organisations where id = ${organisationId}`);
		if (!org || org.name.trim() !== confirmName.trim()) throw badRequest('name_mismatch', 'type the organisation’s name exactly to delete it');
		for (const revoke of this.#revokers) await revoke(actor, organisationId).catch(() => undefined);
		const tables = await this.tables();
		const rowCounts: Record<string, number> = {};
		await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			for (const table of tables) { const rows = await tx.unsafe<{ count: number }[]>(`select count(*)::int as count from "${table.name}" where organisation_id = $1`, [organisationId]); rowCounts[table.name] = rows[0]?.count ?? 0; }
			await tx`insert into organisation_deletions (deleted_organisation_id, name, deleted_by, deleted_by_email, row_counts) values (${organisationId}, ${org.name}, ${actor.userId}, ${actor.email}, ${tx.json(rowCounts as never)})`;
			await tx`delete from organisations where id = ${organisationId}`;
		});
		return { name: org.name, rowCounts };
	}
}
