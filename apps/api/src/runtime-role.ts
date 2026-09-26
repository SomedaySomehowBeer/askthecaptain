import type { Sql, TransactionSql } from '@captain/db';

/** D6 is a live connection requirement, not merely a migration/test property. Check both the
 * session and effective roles, including privileged memberships that could restore bypass. */
export async function runtimeRoleIsSafe(db: Sql | TransactionSql): Promise<boolean> {
	const [row] = await db<{ safe: boolean }[]>`
		select current_setting('row_security') = 'on'
		and not exists (select 1 from pg_auth_members m
			where m.member in (current_user::regrole, session_user::regrole))
		and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname in ('public', 'workflow_queue')
			and c.relowner in (current_user::regrole, session_user::regrole))
		and not exists (select 1 from pg_namespace n where n.nspname in ('public', 'workflow_queue')
			and n.nspowner in (current_user::regrole, session_user::regrole))
		and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			where n.nspname in ('public', 'workflow_queue')
			and p.proowner in (current_user::regrole, session_user::regrole))
		and not exists (select 1 from pg_database d where d.datname = current_database()
			and d.datdba in (current_user::regrole, session_user::regrole))
		and not exists (
			select 1 from pg_roles r
			where (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication
				or r.rolname in ('neon_superuser', 'pg_read_all_data', 'pg_write_all_data'))
			and (r.rolname in (current_user, session_user)
				or pg_has_role(current_user, r.oid, 'MEMBER')
				or pg_has_role(session_user, r.oid, 'MEMBER'))
		) as safe`;
	return row?.safe === true;
}

export async function requireSafeRuntimeRole(db: Sql): Promise<void> {
	if (!await runtimeRoleIsSafe(db)) {
		throw new Error('Unsafe database runtime role: use a non-administrative role with row security enabled (D6).');
	}
}
