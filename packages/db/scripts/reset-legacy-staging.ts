/** One-time, owner-authorised staging reset for the Captain/Pip split. Never part of migrations or startup. */
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';

const remove = [
 'push_deliveries', 'briefs', 'mail_triage', 'note_triage', 'sent_triage', 'outbox',
 'workflow_run_steps', 'workflow_runs', 'workflow_enablements',
 'project_sources', 'project_candidate_sources', 'project_candidates', 'discovery_seeds',
 'notes', 'answers', 'content_vectors', 'evidence', 'task_tags', 'tasks', 'task_series', 'projects',
 'attachment_text', 'mail_attachments', 'mail_messages', 'mail_threads', 'mail_senders',
 'calendar_events', 'calendars', 'contacts', 'companies',
 'webhook_attempts', 'webhook_events', 'sync_cursors', 'connections', 'audit_events'
] as const;
// These were empty in the actual 25 September audit. Do not sweep subsequently created workspace records.
const empty = ['equipment_reservations', 'equipment', 'tags', 'stock_counts', 'stock_items',
 'shopify_reorder_points', 'shopify_inventory_levels', 'shopify_orders', 'shopify_products',
 'xero_payments', 'xero_invoices', 'xero_contacts'] as const;
const preserve = ['organisations', 'users', 'identities', 'sessions', 'passkeys', 'auth_requests', 'auth_events',
 'memberships', 'invitations', 'organisation_deletions', 'inference_runtimes', 'model_budgets', 'model_usage',
 'push_subscriptions', 'schema_migrations', 'workflow_definitions'] as const;
const tables = [...remove, ...empty, ...preserve].sort();
const marker = 'workspace.legacy_data_reset';

export async function resetLegacyStaging(sql: Sql, options: { appName: string; expectedDigest?: string }) {
 if (options.appName !== 'askthecaptain-api-staging') throw new Error('Only askthecaptain-api-staging is permitted');
 return sql.begin(async tx => {
  await tx`set local lock_timeout = '10s'`;
  await tx`set local statement_timeout = '120s'`;
  const [role] = await tx`select rolsuper or rolbypassrls as allowed from pg_roles where rolname=current_user`;
  if (!role?.allowed) throw new Error('Migration-owner connection required');
  const actual = (await tx`select tablename from pg_tables where schemaname='public' order by tablename`).map(r => r.tablename);
  if (JSON.stringify(actual) !== JSON.stringify(tables)) throw new Error('Unexpected schema; review the deletion scope');
  // All writers, including identity/config changes, are held while the count manifest is verified.
  await tx.unsafe(`lock table ${tables.map(t => `public."${t}"`).join(', ')} in share row exclusive mode`);
  const [latest] = await tx`select name from schema_migrations order by name desc limit 1`;
  if (latest?.name !== '0036_equipment_reservations.sql') throw new Error('Reset is only valid before the retirement release (0037/0038)');
  const organisations = await tx`select id from organisations`;
  if (organisations.length !== 1) throw new Error('Expected the one audited organisation');
  const org = organisations[0]!.id as string;
  if ((await tx`select 1 from audit_events where action=${marker}`).length) throw new Error('Legacy reset already completed');
  if ((await tx`select 1 from connections where provider <> 'google'`).length) throw new Error('A business connection needs separate review');
  if ((await tx`select 1 from projects where system_kind is distinct from 'obligations'`).length) throw new Error('A named workspace project needs separate review');
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = Number((await tx.unsafe(`select count(*) as n from public."${table}"`))[0]!.n);
  for (const table of empty) if (counts[table]) throw new Error(`New workspace data in ${table}; review before resetting`);
  const queueTables: string[] = [];
  for (const table of ['job', 'schedule']) {
   const [found] = await tx`select to_regclass(${`workflow_queue.${table}`}) as name`;
   if (found?.name) {
    await tx.unsafe(`lock table workflow_queue."${table}" in share row exclusive mode`);
    counts[`workflow_queue.${table}`] = Number((await tx.unsafe(`select count(*) as n from workflow_queue."${table}"`))[0]!.n);
    queueTables.push(table);
   }
  }
  const digest = createHash('sha256').update(JSON.stringify({ org, counts })).digest('hex');
  if (options.expectedDigest === undefined) return { applied: false, digest, counts };
  if (options.expectedDigest !== digest) throw new Error('Database counts changed since preview; inspect a fresh preview');
  // The old API must stay stopped. No provider calls, remote deletion, or OAuth revocation occurs.
  for (const table of queueTables) await tx.unsafe(`delete from workflow_queue."${table}"`);
  for (const table of remove) await tx.unsafe(`delete from public."${table}" where organisation_id = $1`, [org]);
  await tx`delete from auth_requests where kind = 'google_connection'`;
  await tx`delete from workflow_definitions`; // Code-only catalogue is re-synced by the new API.
  for (const table of remove) {
   if (Number((await tx.unsafe(`select count(*) as n from public."${table}"`))[0]!.n)) throw new Error(`Reset left rows in ${table}`);
  }
  // Keep usage and used budget totals: deletion must not invent a fresh paid allowance.
  await tx`insert into audit_events (organisation_id, actor_kind, action, subject_type, subject_id, detail)
   values (${org}, 'system', ${marker}, 'organisation', ${org}, ${tx.json({ authorisation: 'Owner, 25 September 2026', digest, removedCounts: Object.fromEntries(remove.map(t => [t, counts[t]!])) })})`;
  return { applied: true, digest, counts };
 });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
 const args = process.argv.slice(2);
 if (args.length && !(args.length === 2 && args[0] === '--apply' && /^[a-f0-9]{64}$/.test(args[1]!))) throw new Error('Usage: reset-legacy-staging.ts [--apply preview-digest]');
 if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL required');
 const sql = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1 });
 try {
  const result = await resetLegacyStaging(sql, { appName: process.env.FLY_APP_NAME ?? '', expectedDigest: args[1] });
  console.log('CAPTAIN_LEGACY_RESET ' + JSON.stringify(result));
 } catch (error) {
  console.error('CAPTAIN_LEGACY_RESET_FAILED ' + (error instanceof Error && !('query' in error) ? error.message : 'Database operation failed; transaction rolled back'));
  process.exitCode = 1;
 } finally { await sql.end(); }
}
