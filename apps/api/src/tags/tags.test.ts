import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import type { IdentityProvider } from '../auth/google.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { OrganisationLifecycle } from '../organisations/lifecycle.ts';
import type { Tag, WorkTask } from './service.ts';
// Tags (D7 amended; threads contract §3, §5): a name and optionally an owner and dates, attached to threads. A task's
// tags are its thread's; the task tag routes of #135 are retired, so attaching goes through the thread route.
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>;
type Person = { token: string; user: { id: string } };
let owner: Person, member: Person, outsider: Person, org: string, otherOrg: string, task: string, otherTask: string;
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
 next: { subject: 'owner', email: 'owner@example.test', name: 'Owner' },
 authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`, async exchange() { return google.next; },
};
/** The stored revision, for requests that are not testing staleness. */
const rev = async (table: 'tasks' | 'tags' | 'threads', id: string) => Number((await db.owner.unsafe(`select revision from ${table} where id = $1`, [id]))[0]!.revision);
const request = (method: string, path: string, person?: Person, data?: unknown) => app.request(path, { method,
 headers: { 'content-type': 'application/json', ...(person ? { authorization: `Bearer ${person.token}` } : {}) },
 body: data === undefined ? undefined : JSON.stringify(data) });
async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
 const value = await response; assert.equal(value.status, status, await value.clone().text()); return value.json() as Promise<T>;
}
async function signIn(subject: string): Promise<Person> {
 google.next = { subject, email: `${subject}@example.test`, name: subject };
 const start = await app.request('/auth/google/start');
 const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
 const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
 const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
 return json(request('POST', '/auth/session/exchange', undefined, { code }));
}
const base = () => `/v1/organisations/${org}`;
const makeTag = (name: string, person = member, extra: Record<string, unknown> = {}) => json<Tag>(request('POST', `${base()}/tags`, person, { name, ...extra }), 201);
const threadOf = async (taskId: string) => ((await db.owner`select id from threads where task_id = ${taskId}`)[0]?.id ?? null) as string | null;
/** Attach (PUT) or remove (DELETE) a tag on a task's thread, at its current revision. */
const link = async (tagId: string, method = 'PUT', taskId = task, person = member, organisation = org) => {
 const thread = await threadOf(taskId) ?? taskId;
 const path = `/v1/organisations/${organisation}/threads/${thread}/tags/${tagId}`;
 const revision = (await db.owner`select revision from threads where id = ${thread}`)[0]?.revision ?? 1;
 return method === 'PUT' ? request('POST', path, person, { expectedRevision: revision }) : request('DELETE', `${path}?expectedRevision=${revision}`, person);
};
before(async () => {
 if (!databaseUrl) return;
 db = await freshDatabase();
 app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
  organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app) });
 owner = await signIn('tags-owner'); member = await signIn('tags-member'); outsider = await signIn('tags-outsider');
 org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name: 'Brewery' }), 201)).id;
 otherOrg = (await json<{ id: string }>(request('POST', '/v1/organisations', outsider, { name: 'Other business' }), 201)).id;
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${member.user.id}, 'member')`;
 task = (await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Sample pack', ownerId: member.user.id }), 201)).id;
 otherTask = (await json<{ id: string }>(request('POST', `/v1/organisations/${otherOrg}/tasks`, outsider, { title: 'Other tenant task' }), 201)).id;
});
after(async () => { await db?.close(); });
it('active members create and rename flat tags; duplicate names race safely; writes are audited', async () => {
 const tag = await makeTag('  Production  '); assert.equal(tag.name, 'Production');
 assert.deepEqual([tag.ownerId, tag.startsOn, tag.endsOn, tag.archivedAt, tag.revision, tag.createdBy], [null, null, null, null, 1, member.user.id]);
 const renamed = await json<Tag>(request('PATCH', `${base()}/tags/${tag.id}`, member, { expectedRevision: 1, name: 'Operations' }));
 assert.equal(renamed.id, tag.id); assert.equal(renamed.name, 'Operations'); assert.equal(renamed.revision, 2);
 const audit = await db.owner`select action, actor_id, detail from audit_events where subject_id = ${tag.id} order by created_at`;
 assert.deepEqual(audit.map(a => a.action), ['tag.created', 'tag.renamed']);
 assert.ok(audit.every(a => a.actorId === member.user.id));
 assert.deepEqual(audit[1]!.detail.before, { name: 'Production' });
 assert.deepEqual(audit[1]!.detail.after, { name: 'Operations' });
 assert.equal((await json<{ code: string }>(request('PATCH', `${base()}/tags/${tag.id}`, member, { expectedRevision: 1, name: 'Late' }), 409)).code, 'stale_revision');
 const attempts = await Promise.all([request('POST', `${base()}/tags`, member, { name: 'Marketing' }), request('POST', `${base()}/tags`, member, { name: 'marketing' })]);
 assert.deepEqual(attempts.map(r => r.status).sort(), [201, 409]);
 const conflict = await json<{ code: string }>(request('POST', `${base()}/tags`, member, { name: 'OPERATIONS' }), 409);
 assert.equal(conflict.code, 'tag_name_exists');
 const malformed = await app.request(`${base()}/tags`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${member.token}` }, body: '{bad' });
 assert.equal(malformed.status, 400);
 // Names of up to 120 characters: every project name fits since projects became tags.
 assert.equal((await makeTag('x'.repeat(120))).name.length, 120);
 for (const name of ['', '   ', 'x'.repeat(121)]) assert.equal((await request('POST', `${base()}/tags`, member, { name })).status, 400);
 for (const extra of [{ permissions: 'admin' }, { kind: 'project' }, { description: 'Not carried' }])
  assert.equal((await request('POST', `${base()}/tags`, member, { name: 'Valid', ...extra })).status, 400, Object.keys(extra)[0]);
 assert.equal((await request('PATCH', `${base()}/tags/${tag.id}`, member, { name: 'No revision' })).status, 400);
 const page = await json<{ tags: Tag[]; nextOffset: number | null }>(request('GET', `${base()}/tags?limit=1`, member));
 assert.equal(page.tags.length, 1); assert.equal(page.nextOffset, 1);
});
it('a tag’s owner and dates are optional and independent; the end cannot precede the start; archive and restore are edits', async () => {
 const plain = await makeTag('Plain');
 const owned = await makeTag('Owned', member, { ownerId: member.user.id });
 const started = await makeTag('Started', member, { startsOn: '2031-06-01' });
 const ending = await makeTag('Ending', member, { endsOn: '2031-08-31' });
 const launch = await makeTag('Summer lager launch', member, { ownerId: owner.user.id, startsOn: '2031-06-01', endsOn: '2031-08-31' });
 assert.deepEqual([plain, owned, started, ending, launch].map(t => [t.ownerId, t.startsOn, t.endsOn]),
  [[null, null, null], [member.user.id, null, null], [null, '2031-06-01', null], [null, null, '2031-08-31'], [owner.user.id, '2031-06-01', '2031-08-31']]);
 for (const body of [{ name: 'Backwards', startsOn: '2031-09-01', endsOn: '2031-08-01' }, { name: 'Not a day', startsOn: '2031-02-30' }])
  assert.equal((await request('POST', `${base()}/tags`, member, body)).status, 400, body.name);
 assert.equal((await json<{ code: string }>(request('POST', `${base()}/tags`, member, { name: 'Strange owner', ownerId: outsider.user.id }), 400)).code, 'owner_invalid');
 assert.equal((await json<{ code: string }>(request('PATCH', `${base()}/tags/${started.id}`, member, { expectedRevision: 1, endsOn: '2031-05-01' }), 400)).code, 'tag_dates_invalid',
  'a new end checked against the stored start');
 const edited = await json<Tag>(request('PATCH', `${base()}/tags/${launch.id}`, member, { expectedRevision: 1, ownerId: null, endsOn: null }));
 assert.deepEqual([edited.ownerId, edited.startsOn, edited.endsOn, edited.revision], [null, '2031-06-01', null, 2]);
 const archived = await json<Tag>(request('PATCH', `${base()}/tags/${launch.id}`, member, { expectedRevision: 2, archived: true }));
 assert.ok(archived.archivedAt);
 const restored = await json<Tag>(request('PATCH', `${base()}/tags/${launch.id}`, member, { expectedRevision: 3, archived: false }));
 assert.equal(restored.archivedAt, null); assert.equal(restored.revision, 4);
 const audit = await db.owner<{ action: string; detail: Record<string, unknown> }[]>`select action, detail from audit_events where subject_id = ${launch.id} order by created_at`;
 assert.deepEqual(audit.map(a => a.action), ['tag.created', 'tag.updated', 'tag.updated', 'tag.updated']);
 assert.deepEqual(audit[1]!.detail.before, { ownerId: owner.user.id, endsOn: '2031-08-31' });
});
it('retrying concurrent attach/detach on a task’s thread makes one link and one audit per actual change', async () => {
 const tag = await makeTag('Retry-safe');
 const thread = (await threadOf(task))!;
 const before = (await db.owner`select title, status, revision from tasks where id = ${task}`)[0];
 const revision = await rev('threads', thread);
 const results = await Promise.all([0, 1].map(() => request('POST', `${base()}/threads/${thread}/tags/${tag.id}`, member, { expectedRevision: revision })));
 assert.deepEqual(results.map(r => r.status).sort(), [200, 409], 'the second names a revision the first moved on');
 assert.equal((await db.owner`select * from thread_tags where thread_id = ${thread} and tag_id = ${tag.id}`).length, 1);
 assert.equal((await db.owner`select * from chat_audit_events where thread_id = ${thread} and action = 'chat.tag_added' and subject_id = ${tag.id}`).length, 1);
 await json(link(tag.id, 'DELETE')); assert.equal((await link(tag.id, 'DELETE')).status, 200, 'removing it again is a no-op');
 assert.equal((await db.owner`select * from thread_tags where thread_id = ${thread} and tag_id = ${tag.id}`).length, 0);
 assert.equal((await db.owner`select * from chat_audit_events where thread_id = ${thread} and action = 'chat.tag_removed' and subject_id = ${tag.id}`).length, 1);
 assert.deepEqual((await db.owner`select title, status, revision from tasks where id = ${task}`)[0], before, 'tagging changes the thread, not the task');
 for (const method of ['PUT', 'DELETE']) assert.equal((await request(method, `${base()}/tasks/${task}/tags/${tag.id}`, member)).status, 404, `the retired task tag route (${method})`);
});
it('any selected tag matches, other filter kinds combine with AND, and task identity stays stable', async () => {
 const sales = await makeTag('Sales'), production = await makeTag('Brew day');
 await json(link(sales.id)); await json(link(production.id));
 const another = (await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Other work', ownerId: owner.user.id }), 201)).id;
 await json(link(sales.id, 'PUT', another));
 const anyMatch = await json<{ tasks: WorkTask[] }>(request('GET', `${base()}/tasks?tagId=${sales.id}&tagId=${production.id}`, member));
 assert.deepEqual(anyMatch.tasks.map(t => t.id).sort(), [task, another].sort());
 const query = `tagId=${sales.id}&tagId=${production.id}&ownerId=${member.user.id}&status=open`;
 const filtered = await json<{ tasks: WorkTask[]; nextOffset: number | null }>(request('GET', `${base()}/tasks?${query}`, member));
 assert.deepEqual(filtered.tasks.map(t => t.id), [task]); assert.equal(filtered.nextOffset, null);
 assert.deepEqual(filtered.tasks[0]!.tags.map(t => t.id).sort(), [sales.id, production.id].sort());
 await json(request('PATCH', `${base()}/tags/${sales.id}`, member, { expectedRevision: 1, name: 'Wholesale' }));
 const renamed = await json<{ tasks: WorkTask[] }>(request('GET', `${base()}/tasks?${query}`, member));
 assert.equal(renamed.tasks[0]!.tags.find(t => t.id === sales.id)!.name, 'Wholesale');
 const page = await json<{ tasks: WorkTask[]; nextOffset: number | null }>(request('GET', `${base()}/tasks?tagId=${sales.id}&limit=1`, member));
 assert.equal(page.tasks.length, 1); assert.equal(page.nextOffset, 1);
 const second = await json<{ tasks: WorkTask[]; nextOffset: number | null }>(request('GET', `${base()}/tasks?tagId=${sales.id}&limit=1&offset=1`, member));
 assert.notEqual(page.tasks[0]!.id, second.tasks[0]!.id); assert.equal(second.nextOffset, null);
 assert.deepEqual((await json<{ tasks: WorkTask[] }>(request('GET', `${base()}/tasks?tagId=00000000-0000-4000-8000-000000000000`, member))).tasks, []);
 for (const suffix of ['tagId=bad', 'limit=0', 'limit=101', 'offset=-1', 'status=wrong', 'ownerId=me', `projectId=${sales.id}`])
  assert.equal((await request('GET', `${base()}/tasks?${suffix}`, member)).status, 400, suffix);
 assert.ok(!('projectId' in filtered.tasks[0]!), 'a task has no project');
});
it('API and direct RLS prevent other tenants, unauthenticated people and removed members reading or writing tags', async () => {
 const tag = await makeTag('Protected'); await json(link(tag.id));
 const thread = (await threadOf(task))!;
 assert.equal((await request('GET', `${base()}/tags`)).status, 401);
 assert.equal((await request('GET', `${base()}/tags`, outsider)).status, 404);
 assert.equal((await link(tag.id, 'PUT', otherTask)).status, 404, 'another tenant’s task thread');
 const foreignTag = await json<Tag>(request('POST', `/v1/organisations/${otherOrg}/tags`, outsider, { name: 'Foreign tag' }), 201);
 assert.equal((await link(foreignTag.id)).status, 404);
 assert.equal((await request('PATCH', `${base()}/tags/${foreignTag.id}`, member, { expectedRevision: 1, name: 'Stolen' })).status, 404);
 const asMember = <T>(work: Parameters<typeof withTenant<T>>[2], userId = member.user.id) => withTenant<T>(db.app, { organisationId: org, userId }, work);
 assert.equal((await asMember(tx => tx`select * from tags where id = ${foreignTag.id}`)).length, 0);
 assert.equal((await asMember(tx => tx`select * from thread_tags`, outsider.user.id)).length, 0);
 const otherThread = (await threadOf(otherTask))!;
 await assert.rejects(asMember(tx => tx`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) values (${org}, ${otherThread}, ${tag.id}, ${member.user.id})`), /row-level security|foreign key/);
 await assert.rejects(asMember(tx => tx`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) values (${org}, ${thread}, ${foreignTag.id}, ${member.user.id})`), /foreign key/);
 await assert.rejects(asMember(tx => tx`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) values (${org}, ${thread}, ${tag.id}, ${owner.user.id})`), { code: '23514' });
 await db.owner`update memberships set status = 'removed' where organisation_id = ${org} and user_id = ${member.user.id}`;
 assert.equal((await request('GET', `${base()}/tags`, member)).status, 404);
 assert.equal((await link(tag.id, 'DELETE')).status, 404);
 assert.equal((await asMember(tx => tx`select * from tags`)).length, 0);
 assert.equal((await asMember(tx => tx`delete from thread_tags where tag_id = ${tag.id} returning tag_id`)).length, 0);
 await assert.rejects(asMember(tx => tx`insert into tags (organisation_id, name) values (${org}, 'Removed writer')`), /row-level security/);
 await db.owner`update memberships set status = 'active' where organisation_id = ${org} and user_id = ${member.user.id}`;
});
it('a step has no thread of its own, so it carries its task’s tags; an archived tag never hides work', async () => {
 const tag = await makeTag('Brewing');
 const step = await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Checklist step', parentId: task, expectedParentRevision: await rev('tasks', task) }), 201);
 assert.equal(await threadOf(step.id), null);
 await json(link(tag.id));
 const stepDetail = await json<{ tags: { items: { id: string }[] } }>(request('GET', `${base()}/tasks/${step.id}`, member));
 assert.ok(stepDetail.tags.items.some(t => t.id === tag.id), 'the step is part of its task’s thread');
 await json(request('PATCH', `${base()}/tags/${tag.id}`, owner, { expectedRevision: 1, archived: true }));
 assert.deepEqual((await json<{ tasks: WorkTask[] }>(request('GET', `${base()}/tasks?tagId=${tag.id}`, member))).tasks.map(t => t.id), [task]);
});
it('tag writes and their audit roll back together on failure', async () => {
 await db.owner.unsafe(`create function fail_tag_audit() returns trigger language plpgsql as $$ begin
  if new.action = 'tag.created' and new.detail->>'name' = 'Rollback proof' then raise exception 'forced audit failure'; end if;
  return new; end $$; create trigger fail_tag_audit before insert on audit_events for each row execute function fail_tag_audit()`);
 try {
  assert.equal((await request('POST', `${base()}/tags`, member, { name: 'Rollback proof' })).status, 500);
  assert.equal((await db.owner`select * from tags where name = 'Rollback proof'`).length, 0);
 } finally { await db.owner.unsafe('drop trigger fail_tag_audit on audit_events; drop function fail_tag_audit()'); }
});
type Options = { task: { id: string; title: string }; tags: { id: string; name: string; attached: boolean }[]; nextOffset: number | null };
it('task tag choices page confirmed assignments on the task’s thread and preserve their identity through renames', async () => {
 const attached = await makeTag('AAA editor attached'), available = await makeTag('AAB editor available');
 await json(link(attached.id)); const endpoint = `${base()}/tasks/${task}/tag-options`;
 const before = (await db.owner`select count(*)::int as n from audit_events`)[0]!.n;
 const first = await json<Options>(request('GET', `${endpoint}?limit=1`, member));
 assert.equal(first.task.id, task); assert.ok(first.task.title); assert.equal(first.nextOffset, 1);
 assert.deepEqual(first.tags, [{ id: attached.id, name: attached.name, attached: true }]);
 const second = await json<Options>(request('GET', `${endpoint}?limit=1&offset=1`, member));
 assert.deepEqual(second.tags, [{ id: available.id, name: available.name, attached: false }]);
 assert.equal((await db.owner`select count(*)::int as n from audit_events`)[0]!.n, before, 'read does not write audit');
 const empty = await json<Options>(request('GET', `${endpoint}?offset=1000000`, member));
 assert.equal(empty.task.id, task); assert.deepEqual(empty.tags, []); assert.equal(empty.nextOffset, null);
 await json(request('PATCH', `${base()}/tags/${attached.id}`, member, { expectedRevision: 1, name: 'AAA editor renamed' }));
 assert.deepEqual((await json<Options>(request('GET', `${endpoint}?limit=1`, member))).tags, [{ id: attached.id, name: 'AAA editor renamed', attached: true }]);
 await json(link(attached.id, 'DELETE'));
 assert.equal((await json<Options>(request('GET', `${endpoint}?limit=1`, member))).tags[0]!.attached, false);
 for (const query of ['offset=-1', 'offset=1000001', 'limit=0', 'limit=101', 'limit=abc'])
  assert.equal((await request('GET', `${endpoint}?${query}`, member)).status, 400);
});
it('task tag choices refuse foreign, removed-member and step reads without leaking titles', async () => {
 const endpoint = (id: string) => `${base()}/tasks/${id}/tag-options`;
 assert.equal((await request('GET', endpoint(task))).status, 401);
 assert.equal((await request('GET', endpoint(task), outsider)).status, 404);
 assert.equal((await request('GET', endpoint(otherTask), member)).status, 404);
 assert.equal((await request('GET', endpoint('00000000-0000-4000-8000-000000000000'), member)).status, 404);
 assert.equal((await request('GET', endpoint('bad-id'), member)).status, 400);
 const step = await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Editor checklist', parentId: task, expectedParentRevision: await rev('tasks', task) }), 201);
 assert.equal((await request('GET', endpoint(step.id), member)).status, 404);
 const t = await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Eligibility task' }), 201);
 for (const status of ['done', 'cancelled']) {
  await json(request('PATCH', `${base()}/tasks/${t.id}`, owner, { expectedRevision: await rev('tasks', t.id), status }));
  assert.equal((await request('GET', endpoint(t.id), member)).status, 200, 'any top-level task has a thread to tag');
 }
 await db.owner`update memberships set status = 'removed' where organisation_id = ${org} and user_id = ${member.user.id}`;
 try { assert.equal((await request('GET', endpoint(task), member)).status, 404); }
 finally { await db.owner`update memberships set status = 'active' where organisation_id = ${org} and user_id = ${member.user.id}`; }
});
it('tags and thread tags appear in export and cascade with a deleted organisation', async () => {
 const lifecycle = new OrganisationLifecycle(db.app);
 const lines: Record<string, unknown>[] = [];
 for await (const line of lifecycle.export({ userId: owner.user.id, requestId: 'tag-export' }, org)) lines.push(JSON.parse(line));
 assert.ok(lines.some(row => row.table === 'tags')); assert.ok(lines.some(row => row.table === 'thread_tags'));
 assert.ok(!lines.some(row => row.table === 'task_tags'), 'task_tags is gone');
 assert.ok(lines.filter(row => row.table === 'tags').every(row => (row.row as { organisationId: string }).organisationId === org));
 // Delete only a seeded test tenant, never an existing or remote database.
 const foreignTag = await json<Tag>(request('POST', `/v1/organisations/${otherOrg}/tags`, outsider, { name: 'Cascade' }), 201);
 await json(link(foreignTag.id, 'PUT', otherTask, outsider, otherOrg));
 await lifecycle.delete({ userId: outsider.user.id, email: 'tags-outsider@example.test', requestId: 'tag-delete' }, otherOrg, 'Other business');
 assert.equal((await db.owner`select * from tags where organisation_id = ${otherOrg}`).length, 0);
 assert.equal((await db.owner`select * from thread_tags where organisation_id = ${otherOrg}`).length, 0);
});
