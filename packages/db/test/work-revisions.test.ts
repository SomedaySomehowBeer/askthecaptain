import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMigrations } from '../src/migrate.ts';
import { databaseUrl, freshDatabase } from './harness.ts';

// Migration 0039 (#131): the database owns task, project and series revisions, and an occurrence owns its evidence rule.
const it = databaseUrl ? test : test.skip;

it('existing rows start at revision 1, occurrences keep their series evidence rule, and every update moves the revision', async () => {
	const db = await freshDatabase({ through: '0038_optional_projects.sql' });
	try {
		const [org] = await db.owner`insert into organisations (name) values ('Revisions') returning id`;
		const [project] = await db.owner`insert into projects (organisation_id, name) values (${org!.id}, 'P') returning id`;
		const [strict] = await db.owner`insert into task_series (organisation_id, title, recurrence, anchor, evidence_required) values (${org!.id}, 'Strict', 'monthly', '2026-01-01', true) returning id`;
		const [loose] = await db.owner`insert into task_series (organisation_id, title, recurrence, anchor) values (${org!.id}, 'Loose', 'monthly', '2026-01-01') returning id`;
		const occurrence = async (series: string) => (await db.owner`insert into tasks (organisation_id, title, series_id, period_start, period_end, source_kind)
			values (${org!.id}, 'O', ${series}, '2026-09-01', '2026-09-30', 'series') returning id`)[0]!.id as string;
		const [strictTask, looseTask] = [await occurrence(strict!.id), await occurrence(loose!.id)];
		const [plain] = await db.owner`insert into tasks (organisation_id, project_id, title) values (${org!.id}, ${project!.id}, 'Plain') returning id`;
		assert.deepEqual(await applyMigrations(db.owner, undefined, '0039_work_revisions.sql'), ['0039_work_revisions.sql']);

		const rows = await db.owner`select id, revision, evidence_required from tasks order by id`;
		assert.ok(rows.every((r) => r.revision === 1), 'the backfill does not move any revision');
		assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.evidenceRequired])), { [strictTask]: true, [looseTask]: false, [plain!.id]: false });

		await db.owner`update task_series set evidence_required = false where id = ${strict!.id}`;
		assert.equal((await db.owner`select evidence_required from tasks where id = ${strictTask}`)[0]!.evidenceRequired, true, 'editing the series leaves the occurrence');
		for (const [table, id] of [['tasks', plain!.id], ['projects', project!.id], ['task_series', strict!.id]] as const) {
			await db.owner.unsafe(`update ${table} set updated_at = now(), revision = 99 where id = $1`, [id]);
			await db.owner.unsafe(`update ${table} set updated_at = now() where id = $1`, [id]);
			const [row] = await db.owner.unsafe(`select revision from ${table} where id = $1`, [id]);
			assert.equal(row!.revision, table === 'task_series' ? 4 : 3, `${table}: a supplied revision is ignored and each update counts`);
		}
		await assert.rejects(db.owner`insert into tasks (organisation_id, title, revision) values (${org!.id}, 'Bad', 0)`, /check constraint/);
	} finally { await db.close(); }
});
