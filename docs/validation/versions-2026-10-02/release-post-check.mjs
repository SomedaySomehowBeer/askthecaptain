import postgres from 'postgres';
const sql = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1, ssl: 'require', onnotice() {} });
try {
  const out = await sql.begin('read only', async tx => {
    const one = async q => Number((await tx.unsafe(q))[0].n);
    const applied = await tx`select name, applied_at from schema_migrations where name >= '0047' order by name`;
    const rls = await tx`select count(*)::int as n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relname in ('change_sets','record_changes','record_versions','xero_sync_state') and c.relrowsecurity and c.relforcerowsecurity`;
    return { at: new Date().toISOString(), applied, organisations: await one('select count(*) as n from organisations'),
      baseline_change_sets: await one(`select count(*) as n from change_sets where cause_kind = 'baseline'`), change_sets: await one('select count(*) as n from change_sets'),
      record_versions: await one('select count(*) as n from record_versions'), record_changes: await one('select count(*) as n from record_changes'),
      journalled_records: await one('select (select count(*) from tasks) + (select count(*) from task_series) + (select count(*) from equipment) + (select count(*) from equipment_reservations) + (select count(*) from stock_items) + (select count(*) from tags) + (select count(*) from threads) as n'),
      change_lines: await one(`select count(*) as n from thread_messages where kind = 'change'`), xero_sync_state: await one('select count(*) as n from xero_sync_state'), rls_forced: rls[0].n };
  });
  console.log('R3_POST ' + JSON.stringify(out));
} catch (e) { console.log('POST_FAIL ' + String(e && e.message).slice(0, 200)); process.exitCode = 1; }
finally { await sql.end({ timeout: 5 }); }
