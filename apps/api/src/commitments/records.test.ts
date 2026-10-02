import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { withTenant } from '@captain/db';
import { databaseUrl, fixture, freshDatabase, withJournalledTenant, type Harness } from '@captain/db/test';
import { TagsService } from '../tags/service.ts';
import { CommitmentsService } from './service.ts';

// Work record pages (#131, #133 step 5): bounded reads, and every edit of an existing task or series names the revision
// it was based on. Since 0046 a task has no project: its tags are its thread's. Runs against a real Postgres.
const it = databaseUrl ? test : test.skip;
let db: Harness; let c: CommitmentsService;
before(async () => { if (databaseUrl) { db = await freshDatabase(); c = new CommitmentsService(db.app); } });
after(async () => { await db?.close(); });

async function organisation(name = 'Work records') {
	const [o] = await db.owner`insert into organisations (name, timezone) values (${name}, 'Australia/Perth') returning id`;
	const [u, m] = await db.owner`insert into users (email) values (${randomUUID() + '@example.test'}), (${randomUUID() + '@example.test'}) returning id`;
	const org = String(o!.id), actor = { userId: String(u!.id), requestId: randomUUID() }, member = { userId: String(m!.id), requestId: randomUUID() };
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${actor.userId}, 'owner'), (${org}, ${member.userId}, 'member')`;
	const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, { organisationId: org, userId: actor.userId }, fn);
	const write = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withJournalledTenant(db.app, { organisationId: org, userId: actor.userId }, fn);
	return { org, actor, member, tx, write };
}
const pages = { checklistOffset: 0, evidenceOffset: 0, tagOffset: 0, limit: 50 };
const revisionOf = async (table: 'tasks' | 'task_series' | 'equipment_reservations', id: string) =>
	Number((await db.owner.unsafe(`select revision from ${table} where id = $1`, [id]))[0]!.revision);

it('a task detail is bounded and complete: parent, series, checklist, evidence and its thread’s tags page with honest next offsets', async () => {
	const f = await organisation(); const tags = new TagsService(db.app);
	const task = await c.createTask(f.actor, f.org, { title: 'Clean the cold room' });
	for (let i = 0; i < 3; i++) await c.createTask(f.actor, f.org, { title: `Step ${i}`, parentId: task.id, expectedParentRevision: await revisionOf('tasks', task.id) });
	for (let i = 0; i < 3; i++) await c.addEvidence(f.actor, f.org, task.id, { expectedRevision: await revisionOf('tasks', task.id), kind: 'url', reference: `https://example.test/${i}` });
	for (const name of ['Beta', 'alpha', 'Gamma']) {
		const tag = await tags.create(f.actor, f.org, { name });
		await f.write((sql) => sql`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) select organisation_id, id, ${tag.id}, ${f.actor.userId} from threads where task_id = ${task.id}`);
	}

	const first = await c.task(f.actor, f.org, task.id, { ...pages, limit: 2 });
	assert.equal(first.task.revision, 7, 'three checklist items and three evidence changes each moved the task on; tags did not');
	assert.deepEqual([first.task.evidence.length, first.task.evidenceCount, first.evidenceNextOffset], [2, 3, 2]);
	assert.deepEqual([first.checklist.tasks.map((t) => t.title), first.checklist.nextOffset], [['Step 0', 'Step 1'], 2]);
	assert.ok(first.checklist.tasks.every((t) => t.evidence.length === 0 && t.parentId === task.id && !('projectId' in t)));
	assert.deepEqual([first.tags.items.map((t) => t.name), first.tags.nextOffset], [['alpha', 'Beta'], 2]);
	assert.deepEqual([first.parent, first.series, first.timezone], [null, null, 'Australia/Perth']); assert.ok(!('project' in first));
	const rest = await c.task(f.actor, f.org, task.id, { checklistOffset: 2, evidenceOffset: 2, tagOffset: 2, limit: 2 });
	assert.deepEqual([rest.checklist.tasks.map((t) => t.title), rest.checklist.nextOffset, rest.task.evidence.length, rest.evidenceNextOffset, rest.tags.items.map((t) => t.name), rest.tags.nextOffset],
		[['Step 2'], null, 1, null, ['Gamma'], null]);

	// A checklist item reads on its own, with its parent and its task's tags; a cancelled task is still readable.
	const step = first.checklist.tasks[0]!;
	const stepDetail = await c.task(f.actor, f.org, step.id, pages);
	assert.deepEqual(stepDetail.parent, { id: task.id, title: 'Clean the cold room' });
	assert.deepEqual(stepDetail.tags.items.map((t) => t.name), ['alpha', 'Beta', 'Gamma'], 'a step is part of its task’s thread');
	await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 7, status: 'cancelled' });
	assert.equal((await c.task(f.actor, f.org, task.id, pages)).task.status, 'cancelled');
	assert.equal((await c.task(f.actor, f.org, step.id, pages)).task.status, 'cancelled', 'the cascade cancelled its checklist');
	// Reopening a cancelled task is an ordinary revision-checked edit.
	assert.equal((await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 8, status: 'open' })).status, 'open');
});

it('a stale or retried edit is refused, and of two concurrent edits from the same revision exactly one wins', async () => {
	const f = await organisation();
	const task = await c.createTask(f.actor, f.org, { title: 'Order malt' });
	assert.equal((await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, title: 'Order pale malt' })).revision, 2);
	await assert.rejects(c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, title: 'Order pale malt' }), { status: 409, code: 'stale_revision' }, 'a retry after an uncertain response');
	const results = await Promise.allSettled([
		c.updateTask(f.actor, f.org, task.id, { expectedRevision: 2, title: 'First' }),
		c.updateTask(f.member, f.org, task.id, { expectedRevision: 2, title: 'Second' })]);
	assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
	assert.equal(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as { code: string }).code, 'stale_revision');
	assert.equal(await revisionOf('tasks', task.id), 3);
	const series = await c.createSeries(f.actor, f.org, { title: 'Stock check', recurrence: 'monthly', anchor: '2026-01-01' });
	await assert.rejects(c.updateSeries(f.actor, f.org, series.id, { expectedRevision: 2, title: 'Count' }), { code: 'stale_revision' });
	// The database moves the revision for every update, whoever writes it, and ignores a supplied value.
	await fixture(db.owner, f.org)`update tasks set revision = 1, title = 'Direct' where id = ${task.id}`;
	assert.equal(await revisionOf('tasks', task.id), 4);
});

it('adding a checklist item names the parent revision and moves it on; item edits and cascades move the items', async () => {
	const f = await organisation();
	const task = await c.createTask(f.actor, f.org, { title: 'Launch the lager' });
	await assert.rejects(c.createTask(f.actor, f.org, { title: 'Labels', parentId: task.id }), { code: 'revision_required' });
	await assert.rejects(c.createTask(f.actor, f.org, { title: 'Labels', parentId: task.id, expectedParentRevision: 2 }), { code: 'stale_revision' });
	const item = await c.createTask(f.actor, f.org, { title: 'Labels', parentId: task.id, expectedParentRevision: 1 });
	assert.equal(await revisionOf('tasks', task.id), 2, 'the parent snapshot changed');
	await assert.rejects(c.createTask(f.actor, f.org, { title: 'Kegs', parentId: task.id, expectedParentRevision: 1 }), { code: 'stale_revision' }, 'a retried add is refused');
	await c.updateTask(f.actor, f.org, item.id, { expectedRevision: 1, status: 'in_progress' });
	assert.deepEqual([await revisionOf('tasks', item.id), await revisionOf('tasks', task.id)], [2, 2], "an item's own edit does not stale its parent's editor");
	await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 2, status: 'done' });
	const [row] = await db.owner`select status, revision from tasks where id = ${item.id}`;
	assert.deepEqual([row!.status, row!.revision], ['done', 3], 'the completion moved the item');
	await assert.rejects(c.updateTask(f.actor, f.org, item.id, { expectedRevision: 2, title: 'Stale' }), { code: 'stale_revision' });
});

it('evidence and completion serialise on the task: a done duty cannot silently lose its last evidence', async () => {
	const f = await organisation();
	const series = await c.createSeries(f.actor, f.org, { title: 'Excise return', recurrence: 'monthly', anchor: '2026-01-01', evidenceRequired: true });
	const [occurrence] = await f.tx((sql) => sql`select id from tasks where series_id = ${series.id}`);
	const id = String(occurrence!.id);
	const evidence = await c.addEvidence(f.actor, f.org, id, { expectedRevision: 1, kind: 'url', reference: 'https://ato.example/1' });
	await assert.rejects(c.addEvidence(f.actor, f.org, id, { expectedRevision: 2, kind: 'mail', reference: 'gmail:1' }), { code: 'evidence_kind_retired' });
	// Race completion against removing the only evidence, from the same revision: one waits for the other's
	// lock and then finds the revision moved, so the task never ends up done without evidence.
	const raced = await Promise.allSettled([
		c.updateTask(f.actor, f.org, id, { expectedRevision: 2, status: 'done' }),
		c.removeEvidence(f.member, f.org, evidence.id, { expectedRevision: 2 })]);
	assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
	const [state] = await db.owner`select status, (select count(*)::int from evidence where task_id = ${id}) as n from tasks where id = ${id}`;
	assert.ok(!(state!.status === 'done' && state!.n === 0), 'never done without its evidence');
	if (state!.status === 'done') {
		await assert.rejects(c.removeEvidence(f.actor, f.org, evidence.id, { expectedRevision: await revisionOf('tasks', id) }), { status: 409, code: 'evidence_required' });
		await c.updateTask(f.actor, f.org, id, { expectedRevision: await revisionOf('tasks', id), status: 'open' });
		await c.removeEvidence(f.actor, f.org, evidence.id, { expectedRevision: await revisionOf('tasks', id) });
	}
	assert.equal((await db.owner`select count(*)::int as n from evidence where task_id = ${id}`)[0]!.n, 0, 'removable once the task is reopened (or if removal won)');
});

it('removed members and other tenants can neither read nor change work, even with a current revision', async () => {
	const f = await organisation(); const other = await organisation('Other business');
	const task = await c.createTask(f.actor, f.org, { title: 'Ours' });
	const theirs = await c.createTask(other.actor, other.org, { title: 'Theirs' });
	await assert.rejects(c.task(f.actor, f.org, theirs.id, pages), { status: 404 }, "another tenant's task through our organisation");
	await assert.rejects(c.updateTask(f.actor, f.org, theirs.id, { expectedRevision: 1, title: 'Taken' }), { status: 404 });
	await assert.rejects(c.task(other.actor, f.org, task.id, pages), { status: 404 }, 'a stranger to our organisation');
	await assert.rejects(c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, ownerId: other.actor.userId }), { code: 'owner_invalid' });
	await db.owner`update memberships set status = 'removed' where organisation_id = ${f.org} and user_id = ${f.member.userId}`;
	// Each attempt starts only when it is awaited, so no rejection goes unhandled in between.
	for (const attempt of [() => c.task(f.member, f.org, task.id, pages), () => c.seriesList(f.member, f.org, { offset: 0, limit: 50 }),
		() => c.updateTask(f.member, f.org, task.id, { expectedRevision: 1, title: 'Gone' }),
		() => c.createTask(f.member, f.org, { title: 'Gone' }), () => c.workOptions(f.member, f.org, { taskOffset: 0, limit: 100 })])
		await assert.rejects(attempt(), { status: 404 });
	await assert.rejects(c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, ownerId: f.member.userId }), { code: 'owner_invalid' }, 'a removed member cannot be made the owner');
	assert.equal((await c.task(other.actor, other.org, theirs.id, pages)).task.title, 'Theirs', 'nothing leaked across');
});

it('options and series lists page and search without hidden truncation', async () => {
	const f = await organisation(); const tags = new TagsService(db.app);
	await c.createTask(f.actor, f.org, { title: 'Standalone sweep' });
	await c.createTask(f.actor, f.org, { title: '100% sweep' });
	const hidden = await c.createTask(f.actor, f.org, { title: 'Sweep cancelled' });
	await c.updateTask(f.actor, f.org, hidden.id, { expectedRevision: 1, status: 'cancelled' });
	const parent = await c.createTask(f.actor, f.org, { title: 'Parent' });
	await c.createTask(f.actor, f.org, { title: 'Sweep step', parentId: parent.id, expectedParentRevision: 1 });
	const options = await c.workOptions(f.actor, f.org, { taskOffset: 0, limit: 1, q: 'sweep' });
	assert.deepEqual([options.tasks.items.map((t) => t.label), options.tasks.nextOffset], [['100% sweep'], 1]);
	const next = await c.workOptions(f.actor, f.org, { taskOffset: 1, limit: 1, q: 'sweep' });
	assert.deepEqual([next.tasks.items.map((t) => t.label), next.tasks.nextOffset], [['Standalone sweep'], null], 'no cancelled or checklist tasks');
	assert.deepEqual((await c.workOptions(f.actor, f.org, { taskOffset: 0, limit: 50, q: '%' })).tasks.items.map((t) => t.label), ['100% sweep'], '% is literal');
	assert.ok(!('projects' in options), 'no project choices');

	const tag = await tags.create(f.actor, f.org, { name: 'Alpha' });
	const a = await c.createSeries(f.actor, f.org, { title: 'A check', tagIds: [tag.id], recurrence: 'monthly', anchor: '2999-01-01' });
	const b = await c.createSeries(f.actor, f.org, { title: 'B check', recurrence: 'monthly', anchor: '2999-01-01' });
	await c.updateSeries(f.actor, f.org, b.id, { expectedRevision: 1, paused: true });
	const list = (query: { tagId?: string; paused?: boolean; offset?: number; limit?: number }) => c.seriesList(f.actor, f.org, { offset: 0, limit: 50, ...query });
	assert.deepEqual((await list({ tagId: tag.id })).series.map((s) => [s.id, s.tagIds]), [[a.id, [tag.id]]]);
	assert.deepEqual((await list({ paused: true })).series.map((s) => s.id), [b.id]);
	assert.deepEqual((await list({ paused: false })).series.map((s) => s.id), [a.id]);
	const page = await list({ limit: 1 });
	assert.deepEqual([page.series.map((s) => s.title), page.nextOffset], [['A check'], 1]);
	assert.equal((await c.seriesDetail(f.actor, f.org, b.id)).revision, 2);
	await assert.rejects(c.seriesDetail(f.actor, f.org, randomUUID()), { status: 404 });
});

it('Work lists a series’ occurrences explicitly, whatever their tags', async () => {
	const f = await organisation(); const tags = new TagsService(db.app);
	const tag = await tags.create(f.actor, f.org, { name: 'Seasonal' });
	const series = await c.createSeries(f.actor, f.org, { title: 'Clean lines', tagIds: [tag.id], recurrence: 'monthly', anchor: '2026-01-01' });
	await tags.update(f.actor, f.org, tag.id, { expectedRevision: 1, archived: true });
	assert.equal((await tags.work(f.actor, f.org, {})).tasks.length, 1, 'an archived tag never hides work');
	const bySeries = (await tags.work(f.actor, f.org, { seriesId: series.id })).tasks;
	assert.equal(bySeries.length, 1); assert.equal(bySeries[0]!.seriesId, series.id); assert.equal(bySeries[0]!.revision, 1);
	assert.deepEqual(bySeries[0]!.tags.map((t) => t.id), [tag.id]);
});

it('a booking keeps its tags when its task is edited: a task and its booking are tagged independently', async () => {
	const f = await organisation(); const tags = new TagsService(db.app);
	const [equipment] = await fixture(db.owner, f.org)`insert into equipment (organisation_id, name) values (${f.org}, 'Fermenter') returning id`;
	const task = await c.createTask(f.actor, f.org, { title: 'Brew' });
	const [booking] = await f.write((sql) => sql`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, task_id, created_by)
		values (gen_random_uuid(), ${f.org}, ${equipment!.id}, 'Brew', '2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z', '2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z', ${task.id}, ${f.actor.userId}) returning id`);
	const tag = await tags.create(f.actor, f.org, { name: 'Autumn' });
	await f.write((sql) => sql`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) select organisation_id, id, ${tag.id}, ${f.actor.userId} from threads where reservation_id = ${booking!.id}`);
	assert.equal((await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, title: 'Brew the autumn ale' })).revision, 2);
	assert.equal(await revisionOf('equipment_reservations', String(booking!.id)), 1, 'nothing follows the task any more');
	assert.equal((await db.owner`select count(*)::int as n from thread_tags tt join threads th on th.id = tt.thread_id where th.reservation_id = ${booking!.id}`)[0]!.n, 1);
});

it("a series' evidence rule belongs to each occurrence when it is made; editing the series changes future ones only", async () => {
	const f = await organisation();
	const series = await c.createSeries(f.actor, f.org, { title: 'Licence check', recurrence: 'monthly', anchor: '2026-01-01', evidenceRequired: true });
	const [current] = await f.tx((sql) => sql`select id from tasks where series_id = ${series.id}`);
	await c.updateSeries(f.actor, f.org, series.id, { expectedRevision: 1, evidenceRequired: false });
	const existing = await c.task(f.actor, f.org, String(current!.id), pages);
	assert.equal(existing.task.evidenceRequired, true, 'the existing occurrence keeps the rule it was made with');
	await assert.rejects(c.updateTask(f.actor, f.org, existing.task.id, { expectedRevision: existing.task.revision, status: 'done' }), { code: 'evidence_required' });
	await c.materialise(f.org, '2099-03-15');
	const [next] = await f.tx((sql) => sql`select evidence_required from tasks where series_id = ${series.id} and period_start = '2099-03-01'`);
	assert.equal(next!.evidenceRequired, false, 'the next occurrence follows the edited series');
});

it("a task or series whose owner has left stays editable without re-choosing the owner; a new owner must be active", async () => {
	const f = await organisation();
	const task = await c.createTask(f.actor, f.org, { title: 'Owned', ownerId: f.member.userId });
	const series = await c.createSeries(f.actor, f.org, { title: 'Owned series', ownerId: f.member.userId, recurrence: 'monthly', anchor: '2999-01-01' });
	await db.owner`update memberships set status = 'removed' where organisation_id = ${f.org} and user_id = ${f.member.userId}`;
	assert.equal((await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, ownerId: f.member.userId, title: 'Still owned' })).ownerId, f.member.userId);
	assert.equal((await c.updateSeries(f.actor, f.org, series.id, { expectedRevision: 1, ownerId: f.member.userId, title: 'Still owned' })).ownerId, f.member.userId);
	const other = await c.createTask(f.actor, f.org, { title: 'Unowned' });
	await assert.rejects(c.updateTask(f.actor, f.org, other.id, { expectedRevision: 1, ownerId: f.member.userId }), { code: 'owner_invalid' });
});
