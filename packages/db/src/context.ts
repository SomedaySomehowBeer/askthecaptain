import type { Sql, TransactionSql } from 'postgres';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const assertUuid = (name: string, value: string) => { if (!uuid.test(value)) throw new TypeError(`${name} must be a UUID`); };

export type TenantContext = { organisationId: string; userId?: string };
export type UserContext = { userId: string };

/** Run work in one transaction with the tenant set for Row Level Security. Every read or write of
 *  tenant data goes through here; the policies in the database do the rest. */
export function withTenant<T>(db: Sql, context: TenantContext, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
	assertUuid('organisationId', context.organisationId);
	if (context.userId !== undefined) assertUuid('userId', context.userId);
	return db.begin(async (tx) => {
		await tx`select set_config('app.organisation_id', ${context.organisationId}, true)`;
		if (context.userId !== undefined) await tx`select set_config('app.user_id', ${context.userId}, true)`;
		return work(tx);
	}) as Promise<T>;
}

/** Run work as a signed-in person before an organisation is chosen: the policies then expose the
 *  person's own memberships and the organisations they belong to, and nothing else. */
export function withUser<T>(db: Sql, context: UserContext, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
	assertUuid('userId', context.userId);
	return db.begin(async (tx) => {
		await tx`select set_config('app.user_id', ${context.userId}, true)`;
		return work(tx);
	}) as Promise<T>;
}
