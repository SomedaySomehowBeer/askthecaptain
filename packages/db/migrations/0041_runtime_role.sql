-- D6 repair: the runtime connection must not be able to bypass row security. A provider-made `app` can carry
-- BYPASSRLS, CREATEROLE and membership in the provider's administrative role, and the migration owner may not be
-- allowed to remove them. So the runtime gets its own role, created here in SQL: `captain_runtime`, with no
-- attributes and no memberships. It receives `app`'s direct privileges on the application's own objects and is added
-- to every policy that names `app`. `app` keeps everything, so the running API is unaffected until DATABASE_URL
-- moves to the new role.
--
-- What is copied: privileges granted to `app` itself (never inherited ones, never PUBLIC's) on tables, sequences,
-- columns and functions in the application schemas `public` and `workflow_queue` (extension members excluded), on
-- those schemas, and on this database. Only SELECT, INSERT, UPDATE, DELETE, USAGE, EXECUTE, CONNECT and TEMPORARY
-- are copied, never with grant option; if `app` holds anything else there, this refuses before copying anything.
--
-- The role is created NOLOGIN and without a password; enabling login is an operator step. An existing
-- captain_runtime is checked, never repaired: if it is unsafe, this refuses.
do $$
declare
	runtime constant name := 'captain_runtime';
	-- A role's direct privileges on the application's objects, as `grant <privilege> on <target>` parts. $1 is its oid.
	direct constant text := $q$
		with schemas as (select oid from pg_namespace where nspname in ('public', 'workflow_queue')),
		members as (select classid, objid from pg_depend where deptype = 'e')
		select a.privilege_type as privilege, case when c.relkind = 'S' then 'sequence ' else 'table ' end || c.oid::regclass::text as target, a.is_grantable as grantable
			from pg_class c cross join lateral aclexplode(c.relacl) a
			where a.grantee = $1 and c.relnamespace in (select oid from schemas)
			and not exists (select 1 from members e where e.classid = 'pg_class'::regclass and e.objid = c.oid)
		union all
		select a.privilege_type || ' (' || quote_ident(t.attname) || ')', 'table ' || c.oid::regclass::text, a.is_grantable
			from pg_attribute t join pg_class c on c.oid = t.attrelid cross join lateral aclexplode(t.attacl) a
			where a.grantee = $1 and t.attnum > 0 and not t.attisdropped and c.relnamespace in (select oid from schemas)
			and not exists (select 1 from members e where e.classid = 'pg_class'::regclass and e.objid = c.oid)
		union all
		select a.privilege_type, case when p.prokind = 'p' then 'procedure ' else 'function ' end || p.oid::regprocedure::text, a.is_grantable
			from pg_proc p cross join lateral aclexplode(p.proacl) a
			where a.grantee = $1 and p.pronamespace in (select oid from schemas)
			and not exists (select 1 from members e where e.classid = 'pg_proc'::regclass and e.objid = p.oid)
		union all
		select a.privilege_type, 'schema ' || quote_ident(n.nspname), a.is_grantable
			from pg_namespace n cross join lateral aclexplode(n.nspacl) a where a.grantee = $1 and n.oid in (select oid from schemas)
		union all
		select a.privilege_type, 'database ' || quote_ident(d.datname), a.is_grantable
			from pg_database d cross join lateral aclexplode(d.datacl) a where a.grantee = $1 and d.datname = current_database()
	$q$;
	-- How many direct privileges a role holds anywhere this database can see, in or out of the application's objects.
	everywhere constant text := $q$
		select (select count(*) from pg_class c cross join lateral aclexplode(c.relacl) a where a.grantee = $1)
			+ (select count(*) from pg_attribute t cross join lateral aclexplode(t.attacl) a where a.grantee = $1)
			+ (select count(*) from pg_proc p cross join lateral aclexplode(p.proacl) a where a.grantee = $1)
			+ (select count(*) from pg_namespace n cross join lateral aclexplode(n.nspacl) a where a.grantee = $1)
			+ (select count(*) from pg_database d cross join lateral aclexplode(d.datacl) a where a.grantee = $1 and d.datname = current_database())
			+ (select count(*) from pg_type t cross join lateral aclexplode(t.typacl) a where a.grantee = $1)
			+ (select count(*) from pg_language l cross join lateral aclexplode(l.lanacl) a where a.grantee = $1)
			+ (select count(*) from pg_foreign_data_wrapper w cross join lateral aclexplode(w.fdwacl) a where a.grantee = $1)
			+ (select count(*) from pg_foreign_server s cross join lateral aclexplode(s.srvacl) a where a.grantee = $1)
			+ (select count(*) from pg_largeobject_metadata o cross join lateral aclexplode(o.lomacl) a where a.grantee = $1)
			+ (select count(*) from pg_tablespace s cross join lateral aclexplode(s.spcacl) a where a.grantee = $1)
			+ (select count(*) from pg_parameter_acl p cross join lateral aclexplode(p.paracl) a where a.grantee = $1)
			+ (select count(*) from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a where a.grantee = $1)
	$q$;
	allowed constant text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'USAGE', 'EXECUTE', 'CONNECT', 'TEMPORARY'];
	app_oid oid;
	runtime_oid oid;
	problems text[];
	difference text;
	scoped bigint;
	total bigint;
	item record; -- not `r`: PL/pgSQL would read a query's `r.` alias as this variable
begin
	-- Policies can only be altered, and privileges granted, by the owner of what they protect.
	if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
		raise exception 'migration 0041 must run as the migration owner';
	end if;
	select oid into app_oid from pg_roles where rolname = 'app';
	if app_oid is null then raise exception 'migration 0041 needs the role app'; end if;

	-- Roles are cluster-wide; databases, and so advisory locks, are not. When installations into two databases of one
	-- cluster both find the role missing, the second's insert waits for the first to commit and then fails on the
	-- unique role name. That role is then committed and is checked below like any existing one.
	if not exists (select 1 from pg_roles where rolname = runtime) then
		begin
			execute format('create role %I nologin nosuperuser nobypassrls nocreaterole nocreatedb noreplication', runtime);
		exception when unique_violation or duplicate_object then
			null;
		end;
	end if;

	-- Refusals, all before anything is granted or altered. -------------------------------------------------------
	select candidate.oid, array_remove(array[
		case when candidate.rolsuper then 'superuser' end,
		case when candidate.rolbypassrls then 'bypassrls' end,
		case when candidate.rolcreaterole then 'createrole' end,
		case when candidate.rolcreatedb then 'createdb' end,
		case when candidate.rolreplication then 'replication' end,
		case when exists (select 1 from pg_auth_members m where m.member = candidate.oid) then 'member of another role' end,
		case when exists (select 1 from pg_shdepend d where d.refclassid = 'pg_authid'::regclass and d.refobjid = candidate.oid and d.deptype = 'o')
			then 'owns objects' end], null)
	into runtime_oid, problems from pg_roles candidate where candidate.rolname = runtime;
	if cardinality(problems) > 0 then
		raise exception 'role % is not a safe runtime role: %. This migration changes no existing role; correct it by hand',
			runtime, array_to_string(problems, ', ');
	end if;

	if exists (select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a where a.grantee in (app_oid, runtime_oid)) then
		raise exception 'default privileges name app or %; future objects would diverge, so settle them by hand', runtime;
	end if;

	execute format($f$select string_agg(privilege || ' on ' || target, '; ') from (%s) d
		where split_part(privilege, ' ', 1) <> all ($2)$f$, direct) into difference using app_oid, allowed;
	if difference is not null then
		raise exception 'app holds privileges a runtime must not have, so none are copied: %', difference;
	end if;

	execute format('select count(*) from (%s) d', direct) into scoped using runtime_oid;
	execute everywhere into total using runtime_oid;
	if total > scoped then
		raise exception '% already holds privileges outside the application''s schemas; correct it by hand', runtime;
	end if;

	-- Copy. ---------------------------------------------------------------------------------------------------------
	for item in execute direct using app_oid loop
		execute format('grant %s on %s to %I', item.privilege, item.target, runtime);
	end loop;

	for item in select p.polname, p.polrelid::regclass as rel,
			(select string_agg(case when x = 0 then 'public' else quote_ident(pg_get_userbyid(x)) end, ', ') from unnest(p.polroles || runtime_oid) x) as roles
		from pg_policy p where app_oid = any(p.polroles) and not runtime_oid = any(p.polroles)
	loop
		execute format('alter policy %I on %s to %s', item.polname, item.rel, item.roles);
	end loop;

	-- Verify rather than trust: a grant on something the owner cannot grant only warns. ------------------------------
	execute format($f$select string_agg(privilege || ' on ' || target, '; ') from (
		select privilege, target from (%1$s) a except select privilege, target from (%2$s) b) x$f$, direct, replace(direct, '$1', '$2'))
		into difference using app_oid, runtime_oid;
	if difference is not null then raise exception '% is missing privileges of app: %', runtime, difference; end if;
	execute format($f$select string_agg(privilege || ' on ' || target, '; ') from (
		select privilege, target from (%2$s) b except select privilege, target from (%1$s) a) x$f$, direct, replace(direct, '$1', '$2'))
		into difference using app_oid, runtime_oid;
	if difference is not null then raise exception '% holds privileges app does not: %', runtime, difference; end if;
	execute format('select string_agg(target, $s$; $s$) from (%s) d where grantable', direct) into difference using runtime_oid;
	if difference is not null then raise exception '% may grant its privileges on: %', runtime, difference; end if;
	execute format('select count(*) from (%s) d', direct) into scoped using runtime_oid;
	execute everywhere into total using runtime_oid;
	if total <> scoped then raise exception '% holds privileges outside the application''s schemas', runtime; end if;
	select string_agg(p.polname || ' on ' || p.polrelid::regclass::text, '; ') into difference
		from pg_policy p where (app_oid = any(p.polroles)) <> (runtime_oid = any(p.polroles));
	if difference is not null then raise exception 'policies must name both app and %: %', runtime, difference; end if;
end $$;
