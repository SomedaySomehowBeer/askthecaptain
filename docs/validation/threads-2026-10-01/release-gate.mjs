// Read-only release gate for migration 0046 (docs/plans/threads-2026-09.md §8). Prints counts only: no titles, bodies or names.
import postgres from 'postgres';
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) { console.log('GATE_FAIL no owner connection'); process.exit(1); }
const sql = postgres(url, { max: 1, ssl: 'require', onnotice() {} });
try {
  const out = await sql.begin('read only', async tx => {
    const one = async q => Number((await tx.unsafe(q))[0].n);
    const exists = async t => (await tx`select to_regclass(${'public.' + t}) is not null as e`)[0].e;
    const count = async t => (await exists(t)) ? one(`select count(*) as n from public.${t}`) : null;
    const latest = (await tx`select name from schema_migrations order by name desc limit 1`.catch(() => [{ name: 'unknown' }]))[0]?.name;
    return {
      at: new Date().toISOString(), latest,
      organisations: await count('organisations'),
      projects: await count('projects'),
      projects_with_description: await one(`select count(*) as n from public.projects where btrim(description) <> ''`),
      projects_archived: await one(`select count(*) as n from public.projects where archived_at is not null`),
      project_names_shared_ignoring_case: await one(`select count(*) as n from (select 1 from public.projects group by organisation_id, lower(btrim(name)) having count(*) > 1) d`),
      projects_matching_a_tag_name: await one(`select count(*) as n from public.projects p join public.tags t on t.organisation_id = p.organisation_id and lower(t.name) = lower(btrim(p.name))`),
      tags: await count('tags'), task_tags: await count('task_tags'),
      task_tags_on_steps: await one(`select count(*) as n from public.task_tags tt join public.tasks t on t.id = tt.task_id where t.parent_id is not null`),
      tasks_top_level: await one(`select count(*) as n from public.tasks where parent_id is null`),
      tasks_steps: await one(`select count(*) as n from public.tasks where parent_id is not null`),
      tasks_with_project: await one(`select count(*) as n from public.tasks where project_id is not null`),
      series: await count('task_series'), series_with_project: await one(`select count(*) as n from public.task_series where project_id is not null`),
      reservations: await count('equipment_reservations'), reservations_with_project: await one(`select count(*) as n from public.equipment_reservations where project_id is not null`),
      stock_items: await count('stock_items'), saved_views: await count('saved_views'),
      conversations: await count('conversations'), conversation_participants: await count('conversation_participants'), conversation_links: await count('conversation_links'),
      messages: await count('messages'), message_pins: await count('message_pins'), conversation_stars: await count('conversation_stars'),
      conversation_reads: await count('conversation_reads'), chat_audit_events: await count('chat_audit_events'),
      threads_table_present: await exists('threads')
    };
  });
  console.log('THREADS_GATE ' + JSON.stringify(out));
} catch (e) { console.log('GATE_FAIL ' + (e && e.code ? e.code : 'error') + ' ' + String(e && e.message).slice(0, 160)); process.exitCode = 1; }
finally { await sql.end({ timeout: 5 }); }
