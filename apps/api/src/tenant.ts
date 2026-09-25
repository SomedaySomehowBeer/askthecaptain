import { withUser, type TransactionSql, type Sql } from '@captain/db';
import { notFound } from './errors.ts';

export type Role = 'owner' | 'admin' | 'member';
export type Actor = { userId: string; requestId: string };

/** The signed-in person's role in an organisation, or 404 when they are not an active member: a
 *  stranger learns nothing about whether the organisation exists. */
export async function roleOf(db: Sql, userId: string, organisationId: string): Promise<Role> {
	const [row] = await withUser(db, { userId }, (tx) => tx<{ role: Role }[]>`select role from memberships where organisation_id = ${organisationId} and user_id = ${userId} and status = 'active'`);
	if (!row) throw notFound();
	return row.role;
}
export const canManage = (role: Role) => role === 'owner' || role === 'admin';

export async function requireMember(tx: TransactionSql, userId: string, organisationId: string) {
 const [row] = await tx`select role from memberships where organisation_id = ${organisationId} and user_id = ${userId} and status = 'active'`;
 if (!row) throw notFound(); return row.role as string;
}
