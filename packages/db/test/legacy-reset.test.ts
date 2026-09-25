import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resetLegacyStaging } from '../scripts/reset-legacy-staging.ts';
import { applyMigrations } from '../src/migrate.ts';
import { databaseUrl, freshDatabase } from './harness.ts';
const it = databaseUrl ? test : test.skip;
const appName = 'askthecaptain-api-staging';
it('legacy reset previews, refuses drift, removes content and preserves sign-in/config without resetting spending', async () => {
 const db = await freshDatabase({ through: '0036_equipment_reservations.sql' });
 try {
  const [org] = await db.owner`insert into organisations (name, settings) values ('Old business', '{"inferenceLimitTokens":1000}') returning id`;
  const [user] = await db.owner`insert into users (email,name) values ('reset@example.test','Owner') returning id`;
  await db.owner`insert into memberships (organisation_id,user_id,role) values (${org!.id},${user!.id},'owner')`;
  await db.owner`insert into identities (user_id,provider,subject,email) values (${user!.id},'google','reset-owner','reset@example.test')`;
  const [project] = await db.owner`insert into projects (organisation_id,name,system_kind) values (${org!.id},'Obligations','obligations') returning id`;
  const [task] = await db.owner`insert into tasks (organisation_id,project_id,title,status) values (${org!.id},${project!.id},'Old suggestion','suggested') returning id`;
  await db.owner`insert into tasks (organisation_id,project_id,parent_id,title) values (${org!.id},${project!.id},${task!.id},'Old checklist')`;
  const [connection] = await db.owner`insert into connections (organisation_id,provider,connected_by,account_email,scopes,status,refresh_token_encrypted)
   values (${org!.id},'google',${user!.id},'reset@example.test','{}','connected',decode('abcd','hex')) returning id`;
  await db.owner`insert into mail_threads (organisation_id,connection_id,provider_id,account_email,last_message_at) values (${org!.id},${connection!.id},'old-thread','reset@example.test',now())`;
  await db.owner`insert into model_budgets (organisation_id,month,limit_tokens,used_tokens) values (${org!.id},'2026-09-01',1000,120)`;
  await db.owner.unsafe(`create schema workflow_queue; create table workflow_queue.job (data jsonb); create table workflow_queue.schedule (data jsonb);
   insert into workflow_queue.job values ('{"runId":"old"}'); insert into workflow_queue.schedule values ('{"runId":"old"}')`);
  await assert.rejects(resetLegacyStaging(db.owner, { appName: 'askthecaptain-api' }), /Only/);
  const preview = await resetLegacyStaging(db.owner, { appName });
  assert.equal(preview.applied, false); assert.equal(preview.counts.tasks, 2);
  await db.owner`insert into audit_events (organisation_id,actor_kind,action,subject_type) values (${org!.id},'system','old.write','task')`;
  await assert.rejects(resetLegacyStaging(db.owner, { appName, expectedDigest: preview.digest }), /counts changed/);
  assert.equal((await db.owner`select count(*)::int as n from tasks`)[0]!.n, 2);
  const current = await resetLegacyStaging(db.owner, { appName });
  const done = await resetLegacyStaging(db.owner, { appName, expectedDigest: current.digest });
  assert.equal(done.applied, true);
  assert.equal((await db.owner`select count(*)::int as n from workflow_queue.job`)[0]!.n, 0);
  assert.equal((await db.owner`select count(*)::int as n from workflow_queue.schedule`)[0]!.n, 0);
  await db.owner.unsafe('drop schema workflow_queue cascade');
  for (const table of ['tasks','projects','mail_threads','connections']) assert.equal(Number((await db.owner.unsafe(`select count(*) as n from ${table}`))[0]!.n), 0);
  assert.equal((await db.owner`select count(*)::int as n from identities`)[0]!.n, 1);
  assert.equal((await db.owner`select count(*)::int as n from memberships`)[0]!.n, 1);
  assert.equal(Number((await db.owner`select used_tokens from model_budgets`)[0]!.usedTokens), 120);
  assert.equal((await db.owner`select action from audit_events`)[0]!.action, 'workspace.legacy_data_reset');
  await assert.rejects(resetLegacyStaging(db.owner, { appName }), /already completed/);
  assert.deepEqual(await applyMigrations(db.owner, undefined, '0038_optional_projects.sql'), ['0037_retire_assistant_workflows.sql', '0038_optional_projects.sql']);
 } finally { await db.close(); }
});
it('new workspace data and extra organisations stop the reset before any deletion', async () => {
 const db = await freshDatabase({ through: '0036_equipment_reservations.sql' });
 try {
  const [org] = await db.owner`insert into organisations (name) values ('Only') returning id`;
  await db.owner`insert into equipment (organisation_id,name) values (${org!.id},'New fermenter')`;
  await assert.rejects(resetLegacyStaging(db.owner, { appName }), /New workspace data in equipment/);
  await db.owner`insert into organisations (name) values ('Second')`;
  await assert.rejects(resetLegacyStaging(db.owner, { appName }), /one audited organisation/);
  assert.equal((await db.owner`select count(*)::int as n from equipment`)[0]!.n, 1);
 } finally { await db.close(); }
});
it('every old payload chain is cleared in foreign-key order, while usage, spend and sign-in survive', async () => {
 const db = await freshDatabase({ through: '0036_equipment_reservations.sql' });
 try {
  const secret = 'PRIVATE-LEGACY-PAYLOAD';
  const [org] = await db.owner`insert into organisations (name, settings) values ('Old business', '{"inferenceLimitTokens":1000}') returning id`; const o = org!.id as string;
  const [user] = await db.owner`insert into users (email,name) values ('chain@example.test','Owner') returning id`; const u = user!.id as string;
  await db.owner`insert into memberships (organisation_id,user_id,role) values (${o},${u},'owner')`;
  await db.owner`insert into identities (user_id,provider,subject,email) values (${u},'google','chain-owner','chain@example.test')`;
  // Mail: connection → thread → message → attachment → extracted text, senders, contacts/companies.
  const [connection] = await db.owner`insert into connections (organisation_id,provider,connected_by,account_email,scopes,status,refresh_token_encrypted)
   values (${o},'google',${u},'chain@example.test','{}','connected',decode('abcd','hex')) returning id`; const c = connection!.id as string;
  const [thread] = await db.owner`insert into mail_threads (organisation_id,connection_id,provider_id,account_email,last_message_at) values (${o},${c},'t1','chain@example.test',now()) returning id`;
  const [message] = await db.owner`insert into mail_messages (organisation_id,connection_id,thread_id,provider_id,from_header,to_header,cc_header,subject,date_header,sent_at,snippet,in_reply_to,body)
   values (${o},${c},${thread!.id},'m1',${secret},'','',${secret},'',now(),${secret},'',${secret}) returning id`;
  await db.owner`insert into mail_attachments (organisation_id,message_id,part_id,filename,media_type,size) values (${o},${message!.id},'1',${secret + '.pdf'},'application/pdf',10)`;
  await db.owner`insert into attachment_text (organisation_id,message_id,attachment_id,text) values (${o},${message!.id},'1',${secret})`;
  await db.owner`insert into mail_senders (organisation_id,email) values (${o},'private-legacy-payload@example.test')`;
  const [company] = await db.owner`insert into companies (organisation_id,name,domain) values (${o},${secret},'example.test') returning id`;
  await db.owner`insert into contacts (organisation_id,company_id,name,email,source,last_thread_id) values (${o},${company!.id},${secret},'sender@example.test','mail',${thread!.id})`;
  await db.owner`insert into sync_cursors (organisation_id,connection_id,resource,cursor) values (${o},${c},'gmail',${secret})`;
  const [event] = await db.owner`insert into webhook_events (organisation_id,connection_id,provider,provider_event_id,payload) values (${o},${c},'google','e1',${db.owner.json({ secret })}) returning id`;
  await db.owner`insert into webhook_attempts (organisation_id,connection_id,webhook_event_id,error) values (${o},${c},${event!.id},${secret})`;
  // Calendar: calendar → event → note on the event.
  const [calendar] = await db.owner`insert into calendars (organisation_id,connection_id,account_email,provider_id,name,timezone,access_role) values (${o},${c},'chain@example.test','cal',${secret},'UTC','owner') returning id`;
  const [calendarEvent] = await db.owner`insert into calendar_events (organisation_id,calendar_id,provider_id,status,summary,description,location,starts_at,ends_at,all_day,timezone,organiser,attendees,html_link,updated_at)
   values (${o},${calendar!.id},'ev','confirmed',${secret},${secret},'',now(),now() + interval '1 hour',false,'UTC','{}','[]','https://calendar.example.test',now()) returning id`;
  // Work generated by the old assistant: Obligations, a task with a step and evidence, a series.
  const [project] = await db.owner`insert into projects (organisation_id,name,system_kind) values (${o},'Obligations','obligations') returning id`;
  const [series] = await db.owner`insert into task_series (organisation_id,project_id,title,recurrence,anchor) values (${o},${project!.id},${secret},'monthly','2026-01-01') returning id`;
  const [task] = await db.owner`insert into tasks (organisation_id,project_id,title,body,status,series_id,period_start,period_end,source_kind)
   values (${o},${project!.id},${secret},${secret},'suggested',${series!.id},'2026-09-01','2026-09-30','series') returning id`;
  await db.owner`insert into tasks (organisation_id,project_id,parent_id,title) values (${o},${project!.id},${task!.id},${secret})`;
  await db.owner`insert into evidence (organisation_id,task_id,kind,reference,label) values (${o},${task!.id},'mail','gmail:1',${secret})`;
  // Notes and their triage, vectors, project association, discovery.
  const [note] = await db.owner`insert into notes (organisation_id,author_id,title,body,event_id,project_id,task_id) values (${o},${u},${secret},${secret},${calendarEvent!.id},${project!.id},${task!.id}) returning id`;
  await db.owner`insert into content_vectors (organisation_id,source_kind,source_id,encoder,encoder_version,digest,tokens,vector)
   values (${o},'note',${note!.id},'e','1',${secret},1,array_fill(0::real, array[384])::vector)`;
  await db.owner`insert into project_sources (organisation_id,project_id,source_kind,source_id,linked_by,company_id,rule) values (${o},${project!.id},'mail_thread',${thread!.id},'rule',${company!.id},${secret})`;
  await db.owner`insert into project_candidates (organisation_id,normalised,name,stage) values (${o},'private legacy payload',${secret},'idea')`;
  await db.owner`insert into project_candidate_sources (organisation_id,normalised,source_kind,source_id) values (${o},'private legacy payload','note',${note!.id})`;
  await db.owner`insert into discovery_seeds (organisation_id,kind,key,reason,project_id) values (${o},'note',${secret},${secret},${project!.id})`;
  // Workflows: definition → enablement → run → steps; every run-produced payload; usage and a push delivery.
  await db.owner`insert into workflow_definitions (key,version,name,description,job,triggers,parameters,steps,digest) values ('inbox-triage',1,'Old','',1,'[]','{}','[]','d')`;
  const [enablement] = await db.owner`insert into workflow_enablements (organisation_id,definition_key,definition_version,enabled,enabled_by) values (${o},'inbox-triage',1,true,${u}) returning id`;
  const [run] = await db.owner`insert into workflow_runs (organisation_id,enablement_id,definition_key,definition_version,definition_digest,trigger,state,reason)
   values (${o},${enablement!.id},'inbox-triage',1,'d',${db.owner.json({ secret })},'succeeded',${secret}) returning id`; const r = run!.id as string;
  await db.owner`insert into workflow_run_steps (organisation_id,run_id,path,kind,key,state,output) values (${o},${r},'0','infer','classifyThread','succeeded',${db.owner.json({ secret })})`;
  await db.owner`insert into mail_triage (organisation_id,thread_id,category,needs_owner,summary,facts,produced_by,model,source_message_id) values (${o},${thread!.id},'act',true,${secret},'{}',${r},'m',${message!.id})`;
  await db.owner`insert into sent_triage (organisation_id,message_id,thread_id,category,summary,facts,produced_by,model) values (${o},${message!.id},${thread!.id},'act',${secret},'{}',${r},'m')`;
  await db.owner`insert into note_triage (organisation_id,note_id,category,summary,facts,produced_by,model,body_digest,body_length) values (${o},${note!.id},'act',${secret},'{}',${r},'m','d',1)`;
  await db.owner`insert into outbox (organisation_id,thread_id,connection_id,account_email,"to",subject,body,created_by,idempotency_key) values (${o},${thread!.id},${c},'chain@example.test','{a@example.test}',${secret},${secret},${r},'k1')`;
  await db.owner`insert into briefs (organisation_id,run_id,for_date,title,lines,items) values (${o},${r},'2026-09-01',${secret},'[]','[]')`;
  await db.owner`insert into answers (organisation_id,asked_by,question,answer,sources,confidence,model) values (${o},${u},${secret},${secret},'[]','from_data','m')`;
  const [usage] = await db.owner`insert into model_usage (organisation_id,run_id,step_key,tier,provider,model,input_tokens,output_tokens,cost_micros,latency_ms)
   values (${o},${r},'classifyThread','small','claude','m',100,20,300,5) returning id`;
  await db.owner`insert into model_budgets (organisation_id,month,limit_tokens,used_tokens) values (${o},'2026-09-01',1000,120)`;
  const [subscription] = await db.owner`insert into push_subscriptions (organisation_id,user_id,endpoint,p256dh,auth) values (${o},${u},'https://push.example.test/1','k','a') returning id`;
  await db.owner`insert into push_deliveries (organisation_id,subscription_id,run_id,title,body,state) values (${o},${subscription!.id},${r},${secret},${secret},'sent')`;
  await db.owner`insert into audit_events (organisation_id,actor_kind,action,subject_type,detail) values (${o},'workflow','mail.triaged','mail_thread',${db.owner.json({ secret })})`;

  const preview = await resetLegacyStaging(db.owner, { appName });
  assert.equal((await resetLegacyStaging(db.owner, { appName, expectedDigest: preview.digest })).applied, true);

  // No marked payload remains anywhere in the public schema, whatever table it was in.
  const tables = (await db.owner`select tablename from pg_tables where schemaname = 'public'`).map((t) => t.tablename as string);
  for (const table of tables) {
   const [found] = await db.owner.unsafe(`select count(*)::int as n from public."${table}" x where x::text like '%' || $1 || '%'`, [secret]);
   assert.equal(found!.n, 0, `${table} still holds legacy content`);
  }
  for (const table of ['mail_messages','mail_attachments','attachment_text','mail_threads','mail_senders','calendar_events','calendars','notes','content_vectors','outbox','mail_triage','sent_triage','note_triage',
   'briefs','answers','workflow_run_steps','workflow_runs','workflow_enablements','push_deliveries','project_sources','project_candidates','project_candidate_sources','discovery_seeds',
   'tasks','task_series','evidence','projects','contacts','companies','connections','sync_cursors','webhook_events','webhook_attempts'])
   assert.equal(Number((await db.owner.unsafe(`select count(*) as n from public."${table}"`))[0]!.n), 0, table);

  // Spending stays truthful: the usage row survives without its run, and the month's use is unchanged.
  const [kept] = await db.owner`select run_id, input_tokens, output_tokens, cost_micros from model_usage where id = ${usage!.id}`;
  assert.deepEqual([kept!.runId, Number(kept!.inputTokens), Number(kept!.outputTokens), Number(kept!.costMicros)], [null, 100, 20, 300]);
  assert.equal(Number((await db.owner`select used_tokens from model_budgets where organisation_id = ${o}`)[0]!.usedTokens), 120);
  // Sign-in, membership and a device subscription survive; the old delivery log does not.
  for (const [table, n] of [['users', 1], ['identities', 1], ['memberships', 1], ['push_subscriptions', 1], ['organisations', 1]] as const)
   assert.equal(Number((await db.owner.unsafe(`select count(*) as n from public."${table}"`))[0]!.n), n, table);
  assert.deepEqual(await applyMigrations(db.owner, undefined, '0038_optional_projects.sql'), ['0037_retire_assistant_workflows.sql', '0038_optional_projects.sql']);
 } finally { await db.close(); }
});
