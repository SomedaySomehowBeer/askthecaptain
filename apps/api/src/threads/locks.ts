import type { TransactionSql } from '@captain/db';
import type { Role } from '../tenant.ts';

/** Lock modes for membership rows (linked-chat contract §6, kept for threads). `share` for a person whose membership does not change;
 *  `no key update` for the one row the transaction will update (its status or role), which is the mode that `UPDATE`
 *  takes itself, so the lock is never upgraded and unrelated inserts referencing the row are not blocked. */
export type MembershipLock = 'share' | 'no key update';
export type LockedMembership = { role: Role; status: 'active' | 'removed' };

/** Locks each named person's membership row in `user_id` order, one statement per row, each in its final mode. This is
 *  step 1 of the global lock order: nothing locks a membership after a thread. A person with no membership row
 *  in the organisation is simply absent from the result; callers decide what that means. */
export async function lockMemberships(tx: TransactionSql, organisationId: string, locks: Map<string, MembershipLock>): Promise<Map<string, LockedMembership>> {
 const locked = new Map<string, LockedMembership>();
 // One mode per person; the stronger mode wins if a person was named twice.
 const modes = new Map<string, MembershipLock>();
 for (const [id, mode] of locks) { const key = id.toLowerCase(); if (modes.get(key) !== 'no key update') modes.set(key, mode); }
 // Lower-case UUID strings sort exactly as Postgres orders the uuid type.
 for (const userId of [...modes.keys()].sort()) {
  const mode = modes.get(userId)!;
  const [row] = await tx<LockedMembership[]>`select role, status from memberships where organisation_id = ${organisationId} and user_id = ${userId}
   ${mode === 'share' ? tx`for share` : tx`for no key update`}`;
  if (row) locked.set(userId, row);
 }
 return locked;
}
