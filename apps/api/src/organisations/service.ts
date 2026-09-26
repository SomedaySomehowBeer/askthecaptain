import { createHash, randomBytes } from 'node:crypto';
import { withTenant, withUser, type Sql, type TransactionSql } from '@captain/db';
import { audit } from '../audit.ts';
import { HttpError, badRequest, forbidden, notFound } from '../errors.ts';
import { roleOf } from '../tenant.ts';
import { lockMemberships, type MembershipLock } from '../chat/locks.ts';

export type Role = 'owner' | 'admin' | 'member';
export type Organisation = { id: string; name: string; timezone: string; locale: string; createdAt: Date };
export type Membership = { organisationId: string; organisationName: string; role: Role; status: 'active' | 'removed' };
export type Member = { userId: string; name: string; email: string; role: Role; status: 'active' | 'removed'; since: Date };
export type Invitation = { id: string; email: string; role: Exclude<Role, 'owner'>; invitedBy: string; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null; createdAt: Date };
type Actor = { userId: string; requestId: string };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canManage = (role: Role) => role === 'owner' || role === 'admin';

/** Organisations and who belongs to them. Every write is role-checked here and recorded in the
 *  audit log in the same transaction; the database's policies keep it inside the tenant. */
export class OrganisationService {
	readonly #db: Sql;
	constructor(db: Sql) { this.#db = db; }

	async create(actor: Actor, input: { name: string; timezone?: string }): Promise<Organisation> {
		const name = input.name.trim(); if (!name) throw badRequest('name_required', 'the organisation needs a name');
		// Creating the tenant is the one write that happens before a tenant context exists.
		return this.#db.begin(async (tx) => {
			const [fresh] = await tx<{ id: string }[]>`select uuidv7() as id`; const id = fresh!.id;
			await tx`select set_config('app.organisation_id', ${id}, true)`;
			await tx`select set_config('app.user_id', ${actor.userId}, true)`;
			const [org] = await tx<Organisation[]>`insert into organisations (id, name, timezone) values (${id}, ${name}, ${input.timezone ?? 'Australia/Perth'})
				returning id, name, timezone, locale, created_at`;
			await tx`insert into memberships (organisation_id, user_id, role) values (${org!.id}, ${actor.userId}, 'owner')`;
			// No project is created: tasks and series may stand alone (D7).
			await audit(tx, { organisationId: org!.id, actor: { kind: 'person', id: actor.userId }, action: 'organisation.created', subjectType: 'organisation', subjectId: org!.id, requestId: actor.requestId, detail: { name } });
			return org!;
		}) as Promise<Organisation>;
	}

	async memberships(userId: string): Promise<Membership[]> {
		return withUser(this.#db, { userId }, (tx) => tx<Membership[]>`select m.organisation_id, o.name as organisation_name, m.role, m.status
			from memberships m join organisations o on o.id = m.organisation_id where m.user_id = ${userId} and m.status = 'active' order by o.name`);
	}

	async get(actor: Actor, organisationId: string): Promise<Organisation & { role: Role }> {
		const role = await this.#roleOf(actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [org] = await tx<Organisation[]>`select id, name, timezone, locale, created_at from organisations where id = ${organisationId}`;
			if (!org) throw notFound();
			return { ...org, role };
		});
	}

	async update(actor: Actor, organisationId: string, input: { name?: string; timezone?: string }): Promise<Organisation> {
		const role = await this.#roleOf(actor.userId, organisationId);
		if (!canManage(role)) throw forbidden('only an owner or admin can change the organisation');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [org] = await tx<Organisation[]>`update organisations set name = coalesce(${input.name?.trim() ?? null}, name), timezone = coalesce(${input.timezone ?? null}, timezone)
				where id = ${organisationId} returning id, name, timezone, locale, created_at`;
			await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, action: 'organisation.updated', subjectType: 'organisation', subjectId: organisationId, requestId: actor.requestId, detail: input });
			return org!;
		});
	}

	async members(actor: Actor, organisationId: string): Promise<Member[]> {
		await this.#roleOf(actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, (tx) => tx<Member[]>`select m.user_id, u.name, u.email, m.role, m.status, m.created_at as since
			from memberships m join users u on u.id = m.user_id where m.organisation_id = ${organisationId} and m.status = 'active' order by m.created_at`);
	}

	/** Role changes and removals follow the global lock order (linked-chat contract §6): every affected membership row is
	 *  locked first, sorted by user id, each in its final mode (the changing row `for no key update`, everyone else
	 *  `for share`), and every rule is re-checked under those locks. A concurrent demotion or removal that committed
	 *  first therefore gives 403/404, and two admins acting at once cannot deadlock or remove the last owner. */
	async setRole(actor: Actor, organisationId: string, userId: string, role: Role): Promise<void> {
		const actorRole = await this.#roleOf(actor.userId, organisationId);
		if (!canManage(actorRole)) throw forbidden('only an owner or admin can change roles');
		if (role === 'owner' && actorRole !== 'owner') throw forbidden('only an owner can make another owner');
		await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const { actorRow, target, otherOwners, peekedOwner } = await this.#lockForChange(tx, organisationId, actor.userId, userId, (peeked) => peeked === 'owner' && role !== 'owner');
			if (!canManage(actorRow.role)) throw forbidden('only an owner or admin can change roles');
			if (role === 'owner' && actorRow.role !== 'owner') throw forbidden('only an owner can make another owner');
			if (target.role === 'owner' && actorRow.role !== 'owner') throw forbidden('only an owner can change an owner');
			if (target.role === 'owner' && role !== 'owner') {
				if (!peekedOwner) throw membershipChanged();
				if (otherOwners === 0) throw lastOwner();
			}
			await tx`update memberships set role = ${role} where organisation_id = ${organisationId} and user_id = ${userId}`;
			await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, action: 'membership.role_changed', subjectType: 'membership', subjectId: userId, requestId: actor.requestId, detail: { from: target.role, to: role } });
		});
	}

	/** Removal also ends the person's chat participation in the same transaction (`chat_end_membership`, which returns
	 *  nothing to a caller who may not be a participant). The `membership.removed` audit row carries no chat data. */
	async remove(actor: Actor, organisationId: string, userId: string): Promise<void> {
		const actorRole = await this.#roleOf(actor.userId, organisationId);
		const self = actor.userId.toLowerCase() === userId.toLowerCase();
		if (!canManage(actorRole) && !self) throw forbidden('only an owner or admin can remove members');
		await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const { actorRow, target, otherOwners, peekedOwner } = await this.#lockForChange(tx, organisationId, actor.userId, userId, (peeked) => peeked === 'owner');
			if (!canManage(actorRow.role) && !self) throw forbidden('only an owner or admin can remove members');
			if (target.role === 'owner') {
				if (actorRow.role !== 'owner') throw forbidden('only an owner can remove an owner');
				if (!peekedOwner) throw membershipChanged();
				if (otherOwners === 0) throw lastOwner();
			}
			await tx`update memberships set status = 'removed' where organisation_id = ${organisationId} and user_id = ${userId}`;
			await tx`select chat_end_membership(${userId}::uuid)`;
			await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, action: 'membership.removed', subjectType: 'membership', subjectId: userId, requestId: actor.requestId });
		});
	}

	/** Step 1 of the lock order for a membership change. The target is read once unlocked only to decide whether the other
	 *  active owners must be locked too (for the last-owner rule); then the actor (`for share`), the target
	 *  (`for no key update`, or the single row when acting on oneself) and those owners (`for share`) are locked in
	 *  `user_id` order and the caller re-validates. If the target became an owner after the peek, its owner rows were
	 *  not locked, so the caller refuses with `membership_changed` rather than check an unlocked count. */
	async #lockForChange(tx: TransactionSql, organisationId: string, actorId: string, targetId: string, needsOwners: (peeked: Role) => boolean) {
		const [peek] = await tx<{ role: Role }[]>`select role from memberships where organisation_id = ${organisationId} and user_id = ${targetId} and status = 'active'`;
		if (!peek) throw notFound('that person is not a member');
		const peekedOwner = peek.role === 'owner';
		const owners = needsOwners(peek.role)
			? (await tx<{ userId: string }[]>`select user_id from memberships where organisation_id = ${organisationId} and role = 'owner' and status = 'active' and user_id <> ${targetId}`).map((row) => row.userId)
			: [];
		const locks = new Map<string, MembershipLock>(owners.map((id) => [id, 'share' as const]));
		locks.set(actorId, 'share');
		locks.set(targetId, 'no key update');
		const rows = await lockMemberships(tx, organisationId, locks);
		const actorRow = rows.get(actorId.toLowerCase());
		const target = rows.get(targetId.toLowerCase());
		if (!actorRow || actorRow.status !== 'active') throw notFound();
		if (!target || target.status !== 'active') throw notFound('that person is not a member');
		const otherOwners = owners.filter((id) => { const row = rows.get(id.toLowerCase()); return row?.status === 'active' && row.role === 'owner'; }).length;
		return { actorRow, target, otherOwners, peekedOwner };
	}

	/** Returns the invitation and the one-time token that goes in the link. The token is shown to the
	 *  inviter once and never stored in the clear. */
	async invite(actor: Actor, organisationId: string, input: { email: string; role: Exclude<Role, 'owner'> }): Promise<{ invitation: Invitation; token: string }> {
		const actorRole = await this.#roleOf(actor.userId, organisationId);
		if (!canManage(actorRole)) throw forbidden('only an owner or admin can invite');
		const email = input.email.trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('email_invalid', 'that is not an email address');
		const token = `inv_${randomBytes(32).toString('base64url')}`;
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [existing] = await tx`select 1 from memberships m join users u on u.id = m.user_id where m.organisation_id = ${organisationId} and u.email = ${email} and m.status = 'active'`;
			if (existing) throw badRequest('already_member', 'that person is already a member');
			await tx`update invitations set revoked_at = now() where organisation_id = ${organisationId} and email = ${email} and accepted_at is null and revoked_at is null`;
			const [invitation] = await tx<Invitation[]>`insert into invitations (organisation_id, email, role, token_hash, invited_by, expires_at)
				values (${organisationId}, ${email}, ${input.role}, ${hash(token)}, ${actor.userId}, ${new Date(Date.now() + 7 * 24 * 60 * 60_000)})
				returning id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at`;
			await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, action: 'invitation.created', subjectType: 'invitation', subjectId: invitation!.id, requestId: actor.requestId, detail: { email, role: input.role } });
			return { invitation: invitation!, token };
		});
	}

	async invitations(actor: Actor, organisationId: string): Promise<Invitation[]> {
		const role = await this.#roleOf(actor.userId, organisationId);
		if (!canManage(role)) throw forbidden('only an owner or admin can see invitations');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, (tx) => tx<Invitation[]>`select id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at
			from invitations where organisation_id = ${organisationId} and accepted_at is null and revoked_at is null and expires_at > now() order by created_at desc`);
	}

	async revokeInvitation(actor: Actor, organisationId: string, invitationId: string): Promise<void> {
		const role = await this.#roleOf(actor.userId, organisationId);
		if (!canManage(role)) throw forbidden('only an owner or admin can revoke invitations');
		await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const rows = await tx`update invitations set revoked_at = now() where id = ${invitationId} and organisation_id = ${organisationId} and accepted_at is null and revoked_at is null returning id`;
			if (!rows.length) throw notFound('that invitation is not open');
			await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, action: 'invitation.revoked', subjectType: 'invitation', subjectId: invitationId, requestId: actor.requestId });
		});
	}

	/** The signed-in person accepts with the token from their link. Their signed-in email must be
	 *  the invited one: that is what makes the invitation verified. */
	async accept(actor: Actor & { email: string }, token: string): Promise<Membership> {
		// The invitation is found before any tenant is known, through the one narrow lookup the
		// database allows for that; the token hash is the credential and it is single-use.
		const [found] = await this.#db<{ id: string; organisationId: string; email: string; role: Exclude<Role, 'owner'> }[]>`
			select id, organisation_id, email, role from invitation_by_token(${hash(token)})`;
		if (!found) throw badRequest('invitation_invalid', 'this invitation is not open');
		if (found.email !== actor.email.toLowerCase()) throw forbidden(`this invitation was sent to ${found.email}; sign in with that address`);
		return withTenant(this.#db, { organisationId: found.organisationId, userId: actor.userId }, async (tx) => {
			await tx`update invitations set accepted_at = now() where id = ${found.id}`;
			await tx`insert into memberships (organisation_id, user_id, role) values (${found.organisationId}, ${actor.userId}, ${found.role})
				on conflict (organisation_id, user_id) do update set role = excluded.role, status = 'active'`;
			await audit(tx, { organisationId: found.organisationId, actor: { kind: 'person', id: actor.userId }, action: 'invitation.accepted', subjectType: 'invitation', subjectId: found.id, requestId: actor.requestId });
			const [org] = await tx<{ name: string }[]>`select name from organisations where id = ${found.organisationId}`;
			return { organisationId: found.organisationId, organisationName: org!.name, role: found.role, status: 'active' as const };
		});
	}

	#roleOf(userId: string, organisationId: string): Promise<Role> { return roleOf(this.#db, userId, organisationId); }
}

const lastOwner = () => badRequest('last_owner', 'an organisation needs at least one owner');
const membershipChanged = () => new HttpError(409, 'membership_changed', 'that membership changed while this was being saved; reload and try again');
