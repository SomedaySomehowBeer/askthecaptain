// Read-only check after migration 0046. Prints counts and flags only.
import postgres from 'postgres';
const sql = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1, ssl: 'require', onnotice() {} });
try {
  const out = await sql.begin('read only', async tx => {
    const one = async q => Number((await tx.unsafe(q))[0].n);
    const exists = async t => (await tx`select to_regclass(${'public.' + t}) is not null as e`)[0].e;
    const col = async (t, c) => (await tx`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = ${t} and column_name = ${c}`)[0].n > 0;
    const gone = {}; for (const t of ['conversations','conversation_participants','conversation_links','messages','message_pins','conversation_stars','conversation_reads','projects','task_tags','thread_links']) gone[t] = !(await exists(t));
    const rls = await tx`select c.relname as t, c.relrowsecurity as on, c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('threads','thread_participants','thread_tags','task_series_tags','thread_messages','thread_pins','thread_stars','thread_reads','chat_audit_events') order by 1`;
    return {
      at: new Date().toISOString(),
      latest: (await tx`select name, applied_at from schema_migrations order by name desc limit 1`)[0],
      old_tables_gone: Object.values(gone).every(Boolean), gone,
      project_id_columns_left: [await col('tasks','project_id'), await col('task_series','project_id'), await col('equipment_reservations','project_id')].filter(Boolean).length,
      tags: await one('select count(*) as n from tags'), tags_with_owner: await one('select count(*) as n from tags where owner_id is not null'),
      threads_record: await one(`select count(*) as n from threads where kind = 'record'`), threads_other: await one(`select count(*) as n from threads where kind <> 'record'`),
      threads_task: await one('select count(*) as n from threads where task_id is not null'), threads_reservation: await one('select count(*) as n from threads where reservation_id is not null'), threads_stock: await one('select count(*) as n from threads where stock_item_id is not null'),
      thread_tags: await one('select count(*) as n from thread_tags'), task_series_tags: await one('select count(*) as n from task_series_tags'),
      thread_messages: await one('select count(*) as n from thread_messages'), chat_audit_events: await one('select count(*) as n from chat_audit_events'),
      tasks_top_level: await one('select count(*) as n from tasks where parent_id is null'), reservations: await one('select count(*) as n from equipment_reservations'), stock_items: await one('select count(*) as n from stock_items'),
      rls_all_forced: rls.length === 9 && rls.every(r => r.on && r.forced), rls_tables: rls.length
    };
  });
  console.log('THREADS_POST ' + JSON.stringify(out));
} catch (e) { console.log('POST_FAIL ' + String(e && e.message).slice(0, 200)); process.exitCode = 1; }
finally { await sql.end({ timeout: 5 }); }
