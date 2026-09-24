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
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>;
type Person = { token: string; user: { id: string } };
let owner: Person, member: Person, outsider: Person, org: string, otherOrg: string, task: string, otherTask: string, project: string;
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
 next: { subject: 'owner', email: 'owner@example.test', name: 'Owner' },
 authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`, async exchange() { return google.next; },
};
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
const makeTag = (name: string, person = member) => json<Tag>(request('POST', `${base()}/tags`, person, { name }), 201);
const link = (tagId: string, method = 'PUT', taskId = task, person = member) => request(method, `${base()}/tasks/${taskId}/tags/${tagId}`, person);
before(async () => {
 if (!databaseUrl) return;
 db = await freshDatabase();
 app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
  organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app) });
 owner = await signIn('tags-owner'); member = await signIn('tags-member'); outsider = await signIn('tags-outsider');
 org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name: 'Brewery' }), 201)).id;
 otherOrg = (await json<{ id: string }>(request('POST', '/v1/organisations', outsider, { name: 'Other business' }), 201)).id;
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${member.user.id}, 'member')`;
 project = (await json<{ id: string }>(request('POST', `${base()}/projects`, owner, { name: 'Launch' }), 201)).id;
 task = (await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Sample pack', projectId: project, ownerId: member.user.id }), 201)).id;
 otherTask = (await json<{ id: string }>(request('POST', `/v1/organisations/${otherOrg}/tasks`, outsider, { title: 'Other tenant task' }), 201)).id;
});
after(async () => { await db?.close(); });
it('active members create and rename flat tags; duplicate names race safely; writes are audited', async () => {
 const tag = await makeTag('  Production  '); assert.equal(tag.name, 'Production');
 const renamed = await json<Tag>(request('PATCH', `${base()}/tags/${tag.id}`, member, { name: 'Operations' }));
 assert.equal(renamed.id, tag.id); assert.equal(renamed.name, 'Operations');
 const audit = await db.owner`select action, actor_id, detail from audit_events where subject_id = ${tag.id} order by created_at`;
 assert.deepEqual(audit.map(a => a.action), ['tag.created', 'tag.renamed']);
 assert.ok(audit.every(a => a.actorId === member.user.id));
 assert.deepEqual(audit[1]!.detail.before, { name: 'Production' });
 assert.deepEqual(audit[1]!.detail.after, { name: 'Operations' });
 const attempts = await Promise.all([request('POST', `${base()}/tags`, member, { name: 'Marketing' }), request('POST', `${base()}/tags`, member, { name: 'marketing' })]);
 assert.deepEqual(attempts.map(r => r.status).sort(), [201, 409]);
 const conflict = await json<{ code: string }>(request('POST', `${base()}/tags`, member, { name: 'OPERATIONS' }), 409);
 assert.equal(conflict.code, 'tag_name_exists');
 const malformed = await app.request(`${base()}/tags`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${member.token}` }, body: '{bad' });
 assert.equal(malformed.status, 400);
 for (const name of ['', '   ', 'x'.repeat(61)]) assert.equal((await request('POST', `${base()}/tags`, member, { name })).status, 400);
 assert.equal((await request('POST', `${base()}/tags`, member, { name: 'Valid', permissions: 'admin' })).status, 400);
 const page = await json<{ tags: Tag[]; nextOffset: number | null }>(request('GET', `${base()}/tags?limit=1`, member));
 assert.equal(page.tags.length, 1); assert.equal(page.nextOffset, 1);
});
it('retrying concurrent attach/detach makes one link and one audit per actual change', async () => {
 const tag = await makeTag('Retry-safe');
 const before = (await db.owner`select project_id, title, status from tasks where id = ${task}`)[0];
 const results = await Promise.all([link(tag.id), link(tag.id)]); assert.ok(results.every(r => r.status === 200));
 assert.equal((await db.owner`select * from task_tags where task_id = ${task} and tag_id = ${tag.id}`).length, 1);
 assert.equal((await db.owner`select * from audit_events where subject_id = ${task} and action = 'task.tag_added' and detail->>'tagId' = ${tag.id}`).length, 1);
 await json(link(tag.id, 'DELETE')); await json(link(tag.id, 'DELETE'));
 assert.equal((await db.owner`select * from task_tags where task_id = ${task} and tag_id = ${tag.id}`).length, 0);
 assert.equal((await db.owner`select * from audit_events where subject_id = ${task} and action = 'task.tag_removed' and detail->>'tagId' = ${tag.id}`).length, 1);
 assert.deepEqual((await db.owner`select project_id, title, status from tasks where id = ${task}`)[0], before);
});
it('any selected tag matches, other filter kinds combine with AND, and task identity stays stable', async () => {
 const sales = await makeTag('Sales'), production = await makeTag('Brew day');
 await json(link(sales.id)); await json(link(production.id));
 const another = (await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Other work', ownerId: owner.user.id }), 201)).id;
 await json(link(sales.id, 'PUT', another));
 const anyMatch = await json<{ tasks: WorkTask[] }>(request('GET', `${base()}/tasks?tagId=${sales.id}&tagId=${production.id}`, member));
 assert.deepEqual(anyMatch.tasks.map(t => t.id).sort(), [task, another].sort());
 const query = `tagId=${sales.id}&tagId=${production.id}&ownerId=${member.user.id}&projectId=${project}&status=open`;
 const filtered = await json<{ tasks: WorkTask[]; nextOffset: number | null }>(request('GET', `${base()}/tasks?${query}`, member));
 assert.deepEqual(filtered.tasks.map(t => t.id), [task]); assert.equal(filtered.nextOffset, null);
 assert.deepEqual(filtered.tasks[0]!.tags.map(t => t.id).sort(), [sales.id, production.id].sort());
 await json(request('PATCH', `${base()}/tags/${sales.id}`, member, { name: 'Wholesale' }));
 const renamed = await json<{ tasks: WorkTask[] }>(request('GET', `${base()}/tasks?${query}`, member));
 assert.equal(renamed.tasks[0]!.tags.find(t => t.id === sales.id)!.name, 'Wholesale');
 const page = await json<{ tasks: WorkTask[]; nextOffset: number | null }>(request('GET', `${base()}/tasks?tagId=${sales.id}&limit=1`, member));
 assert.equal(page.tasks.length, 1); assert.equal(page.nextOffset, 1);
 const second = await json<{ tasks: WorkTask[]; nextOffset: number | null }>(request('GET', `${base()}/tasks?tagId=${sales.id}&limit=1&offset=1`, member));
 assert.notEqual(page.tasks[0]!.id, second.tasks[0]!.id); assert.equal(second.nextOffset, null);
 assert.deepEqual((await json<{ tasks: WorkTask[] }>(request('GET', `${base()}/tasks?tagId=00000000-0000-4000-8000-000000000000`, member))).tasks, []);
 for (const suffix of ['tagId=bad', 'limit=0', 'limit=101', 'offset=-1', 'status=wrong', 'ownerId=me'])
  assert.equal((await request('GET', `${base()}/tasks?${suffix}`, member)).status, 400);
});
it('API and direct RLS prevent other tenants, unauthenticated people and removed members reading or writing tags', async () => {
 const tag = await makeTag('Protected'); await json(link(tag.id));
 assert.equal((await request('GET', `${base()}/tags`)).status, 401);
 assert.equal((await request('GET', `${base()}/tags`, outsider)).status, 404);
 assert.equal((await link(tag.id, 'PUT', otherTask)).status, 404);
 const foreignTag = await json<Tag>(request('POST', `/v1/organisations/${otherOrg}/tags`, outsider, { name: 'Foreign tag' }), 201);
 assert.equal((await link(foreignTag.id)).status, 404);
 assert.equal((await request('PATCH', `${base()}/tags/${foreignTag.id}`, member, { name: 'Stolen' })).status, 404);
 assert.equal((await withTenant(db.app, { organisationId: org, userId: member.user.id }, tx => tx`select * from tags where id = ${foreignTag.id}`)).length, 0);
 assert.equal((await withTenant(db.app, { organisationId: org, userId: outsider.user.id }, tx => tx`select * from task_tags`)).length, 0);
 await assert.rejects(withTenant(db.app, { organisationId: org, userId: member.user.id }, tx => tx`insert into task_tags (organisation_id, task_id, tag_id, attached_by) values (${org}, ${otherTask}, ${tag.id}, ${member.user.id})`), /foreign key/);
 await assert.rejects(withTenant(db.app, { organisationId: org, userId: member.user.id }, tx => tx`insert into task_tags (organisation_id, task_id, tag_id, attached_by) values (${org}, ${task}, ${foreignTag.id}, ${member.user.id})`), /foreign key/);
 await assert.rejects(withTenant(db.app, { organisationId: org, userId: member.user.id }, tx => tx`insert into task_tags (organisation_id, task_id, tag_id, attached_by) values (${org}, ${task}, ${tag.id}, ${owner.user.id})`), /row-level security/);
 await db.owner`update memberships set status = 'removed' where organisation_id = ${org} and user_id = ${member.user.id}`;
 assert.equal((await request('GET', `${base()}/tags`, member)).status, 404);
 assert.equal((await link(tag.id, 'DELETE')).status, 404);
 assert.equal((await withTenant(db.app, { organisationId: org, userId: member.user.id }, tx => tx`select * from tags`)).length, 0);
 assert.equal((await withTenant(db.app, { organisationId: org, userId: member.user.id }, tx => tx`delete from task_tags where tag_id = ${tag.id} returning tag_id`)).length, 0);
 await assert.rejects(withTenant(db.app, { organisationId: org, userId: member.user.id }, tx => tx`insert into tags (organisation_id, name) values (${org}, 'Removed writer')`), /row-level security/);
 await db.owner`update memberships set status = 'active' where organisation_id = ${org} and user_id = ${member.user.id}`;
});
it('archived and proposed projects stay out of the active work list', async () => {
 const archived = await json<{ id: string }>(request('POST', `${base()}/projects`, owner, { name: 'Archived' }), 201);
 const hidden = await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Hidden task', projectId: archived.id }), 201);
 const tag = await makeTag('Hidden'); await json(link(tag.id, 'PUT', hidden.id));
 const step = await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Checklist step', parentId: task }), 201);
 assert.equal((await link(tag.id, 'PUT', step.id)).status, 404, 'tags belong to top-level tasks');
 await json(request('PATCH', `${base()}/projects/${archived.id}`, owner, { archived: true }));
 assert.deepEqual((await json<{ tasks: WorkTask[] }>(request('GET', `${base()}/tasks?tagId=${tag.id}`, member))).tasks, []);
 assert.equal((await link(tag.id, 'PUT', hidden.id)).status, 404);
 await db.owner`update projects set archived_at = null, proposed_at = now(), accepted_at = null where id = ${archived.id}`;
 assert.deepEqual((await json<{ tasks: WorkTask[] }>(request('GET', `${base()}/tasks?tagId=${tag.id}`, member))).tasks, []);
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
it('task tag choices page confirmed assignments and preserve their identity through renames', async () => {
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
 await json(request('PATCH', `${base()}/tags/${attached.id}`, member, { name: 'AAA editor renamed' }));
 assert.deepEqual((await json<Options>(request('GET', `${endpoint}?limit=1`, member))).tags, [{ id: attached.id, name: 'AAA editor renamed', attached: true }]);
 await json(link(attached.id, 'DELETE'));
 assert.equal((await json<Options>(request('GET', `${endpoint}?limit=1`, member))).tags[0]!.attached, false);
 for (const query of ['offset=-1', 'offset=1000001', 'limit=0', 'limit=101', 'limit=abc'])
  assert.equal((await request('GET', `${endpoint}?${query}`, member)).status, 400);
});
it('task tag choices refuse foreign, removed-member and ineligible-task reads without leaking titles', async () => {
 const endpoint = (id: string) => `${base()}/tasks/${id}/tag-options`;
 assert.equal((await request('GET', endpoint(task))).status, 401);
 assert.equal((await request('GET', endpoint(task), outsider)).status, 404);
 assert.equal((await request('GET', endpoint(otherTask), member)).status, 404);
 assert.equal((await request('GET', endpoint('00000000-0000-4000-8000-000000000000'), member)).status, 404);
 assert.equal((await request('GET', endpoint('bad-id'), member)).status, 400);
 const step = await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Editor checklist', parentId: task }), 201);
 assert.equal((await request('GET', endpoint(step.id), member)).status, 404);
 const p = await json<{ id: string }>(request('POST', `${base()}/projects`, owner, { name: 'Editor eligibility' }), 201);
 const t = await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Eligibility task', projectId: p.id }), 201);
 for (const status of ['done', 'cancelled']) {
  await json(request('PATCH', `${base()}/tasks/${t.id}`, owner, { status }));
  assert.equal((await request('GET', endpoint(t.id), member)).status, 200, 'matches existing link-write eligibility');
 }
 await json(request('PATCH', `${base()}/projects/${p.id}`, owner, { archived: true }));
 assert.equal((await request('GET', endpoint(t.id), member)).status, 404);
 await db.owner`update projects set archived_at = null, proposed_at = now(), accepted_at = null where id = ${p.id}`;
 assert.equal((await request('GET', endpoint(t.id), member)).status, 404);
 await db.owner`update memberships set status = 'removed' where organisation_id = ${org} and user_id = ${member.user.id}`;
 try { assert.equal((await request('GET', endpoint(task), member)).status, 404); }
 finally { await db.owner`update memberships set status = 'active' where organisation_id = ${org} and user_id = ${member.user.id}`; }
});
it('new tenant tables appear in export and cascade with a deleted organisation', async () => {
 const lifecycle = new OrganisationLifecycle(db.app);
 const lines: Record<string, unknown>[] = [];
 for await (const line of lifecycle.export({ userId: owner.user.id, requestId: 'tag-export' }, org)) lines.push(JSON.parse(line));
 assert.ok(lines.some(row => row.table === 'tags')); assert.ok(lines.some(row => row.table === 'task_tags'));
 assert.ok(lines.filter(row => row.table === 'tags').every(row => (row.row as { organisationId: string }).organisationId === org));
 // Delete only a seeded test tenant, never an existing or remote database.
 const foreignTag = await json<Tag>(request('POST', `/v1/organisations/${otherOrg}/tags`, outsider, { name: 'Cascade' }), 201);
 await json(request('PUT', `/v1/organisations/${otherOrg}/tasks/${otherTask}/tags/${foreignTag.id}`, outsider));
 await lifecycle.delete({ userId: outsider.user.id, email: 'tags-outsider@example.test', requestId: 'tag-delete' }, otherOrg, 'Other business');
 assert.equal((await db.owner`select * from tags where organisation_id = ${otherOrg}`).length, 0);
 assert.equal((await db.owner`select * from task_tags where organisation_id = ${otherOrg}`).length, 0);
});
