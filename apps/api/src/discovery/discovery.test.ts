import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { DiscoveryService } from './service.ts';
import { findSeeds } from './thresholds.ts';
import { activeProjects } from '../triage/association.ts';
import { result, triageFixture, until } from '../../test/triage-fixture.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
const empty = { what: [], standing: [], people: [], questions: [] };

it('thresholds seed candidates and a person’s request; a run proposes a project from evidence; a person accepts or discards it', async () => {
	const f = await triageFixture(db); try {
		const discovery = new DiscoveryService(db.app, f.inference, { embedText: async () => null }); discovery.register(f.registry);
		await f.workflows.enable(f.actor, f.org, 'discover-projects', { enabled: true, parameters: {} });
		// Three threads from CanCo over twenty days proposing one underway name; one thread proposing another: below the line.
		const t1 = await f.mail('cans-1', 'sam@canco.test', 'Artwork for the October cans.'); const t2 = await f.mail('cans-2', 'sam@canco.test', 'Can quote attached.'); const t3 = await f.mail('cans-3', 'sam@canco.test', 'Canning line booked.');
		await f.tx(sql => sql`update mail_threads set last_message_at = now() - interval '20 days' where id = ${t1}`); await f.tx(sql => sql`update mail_threads set last_message_at = now() - interval '10 days' where id = ${t2}`);
		const candidate = (normalised: string, name: string, stage: string, sources: [string, string, boolean][]) => f.tx(async sql => {
			await sql`insert into project_candidates (organisation_id, normalised, name, stage) values (${f.org}, ${normalised}, ${name}, ${stage})`;
			for (const [kind, id, own] of sources) await sql`insert into project_candidate_sources (organisation_id, normalised, source_kind, source_id, own) values (${f.org}, ${normalised}, ${kind}, ${id}, ${own})`;
		});
		await candidate('cans for october', 'Cans for October', 'underway', [['mail_thread', t1, false], ['mail_thread', t2, false], ['mail_thread', t3, false]]);
		const t4 = await f.mail('print-1', 'jo@printer.test', 'Labels quote.'); await candidate('new labels', 'New labels', 'underway', [['mail_thread', t4, false]]);
		// An idea in one thread where both parties wrote: the moment a person most wants it written down.
		const t5 = await f.mail('tap-1', 'lee@landlord.test', 'Would you take the George St site for a taproom?');
		await f.tx(sql => sql`insert into mail_messages (organisation_id, connection_id, thread_id, provider_id, from_header, to_header, cc_header, subject, date_header, sent_at, snippet, in_reply_to, body, rfc_message_id, label_ids)
			values (${f.org}, ${f.conn.id}, ${t5}, 'tap-1-reply', ${f.conn.accountEmail}, 'lee@landlord.test', '', 'Re: Delivery update', '', now(), '', '', 'We are thinking about it.', '<tap-1-reply@business.test>', '{SENT}')`);
		await candidate('city taproom', 'City taproom', 'idea', [['mail_thread', t5, false]]);
		assert.equal(await f.tx(sql => findSeeds(sql, f.org)), 2); assert.equal(await f.tx(sql => findSeeds(sql, f.org)), 0, 'an open seed is not written twice');
		const seeds = await f.tx(sql => sql`select kind, key, reason from discovery_seeds order by key`);
		assert.deepEqual(seeds.map(s => [s.kind, s.key, s.reason]), [['candidate', 'cans for october', 'underway_three_sources_fourteen_days'], ['candidate', 'city taproom', 'idea_both_wrote']]);
		// The person asks about the labels thread; their request runs first. Asking twice queues once.
		assert.deepEqual(await discovery.request(f.member, f.org, { kind: 'mail_thread', id: t4 }), { queued: true });
		assert.deepEqual(await discovery.request(f.member, f.org, { kind: 'mail_thread', id: t4 }), { queued: false });
		f.provider.responses.push(
			result({ kind: 'nothing', belongs: [], name: null, description: null, stage: null, brief: empty, tasks: [] }),
			result({ kind: 'project', belongs: ['c1', 'c2', 'c3', 'c9'], name: 'Cans for October', description: 'Cans and artwork for the October run.', stage: 'underway',
				brief: { what: [{ text: 'A canned run in October with CanCo.', evidence: 'c1' }], standing: [{ text: 'Line booked.', evidence: 'c3' }], people: [{ text: 'Sam at CanCo', evidence: null }], questions: [{ text: 'Final artwork?', evidence: 'c9' }] },
				tasks: [{ title: 'Approve artwork', reference: 'CAN-77', due: null, steps: ['Check colours', 'Sign off'], evidence: 'c1' }] }),
			result({ kind: 'relationship', belongs: ['c1'], name: null, description: null, stage: null, brief: empty, tasks: [] }));
		const run = await f.tx(sql => f.engine.start(sql, f.org, 'discover-projects'));
		const [state] = await until(() => f.tx(sql => sql`select state, reason from workflow_runs where id = ${run}`), rows => ['succeeded', 'failed'].includes(String(rows[0]?.state))).catch(async (error) => {
			console.error(JSON.stringify(await f.tx(sql => sql`select * from workflow_run_steps where run_id = ${run}`), null, 1).slice(0, 4000)); throw error; });
		assert.equal(state!.state, 'succeeded', String(state!.reason));
		const [proposed] = await f.tx(sql => sql`select id, state, stage, brief, proposed_by from projects where name = 'Cans for October'`);
		assert.equal(proposed!.state, 'proposed'); assert.equal(proposed!.proposedBy, run); assert.equal(proposed!.stage, 'underway');
		assert.deepEqual(proposed!.brief.what, [{ text: 'A canned run in October with CanCo.', evidence: { kind: 'mail_thread', id: t1 } }]);
		assert.deepEqual(proposed!.brief.questions, [{ text: 'Final artwork?', evidence: null }], 'an id outside the candidates cites nothing');
		const links = await f.tx(sql => sql`select source_id, linked_by from project_sources where project_id = ${proposed!.id}`);
		assert.deepEqual(links.map(l => l.sourceId).sort(), [t1, t2, t3].sort()); assert.ok(links.every(l => l.linkedBy === 'model'));
		const [task] = await f.tx(sql => sql`select id, status, source_kind, source_id from tasks where project_id = ${proposed!.id} and parent_id is null`);
		assert.deepEqual([task!.status, task!.sourceKind, task!.sourceId], ['suggested', 'run', run]);
		assert.equal((await f.tx(sql => sql`select 1 from tasks where parent_id = ${task!.id} and status = 'suggested'`)).length, 2);
		const [evidence] = await f.tx(sql => sql`select kind, reference from evidence where task_id = ${task!.id}`); assert.deepEqual([evidence!.kind, evidence!.reference], ['mail', t1]);
		const outcomes = await f.tx(sql => sql`select kind, state, outcome, project_id from discovery_seeds order by created_at`);
		assert.deepEqual(outcomes.map(o => [o.kind, o.state, o.outcome, o.projectId]), [['candidate', 'done', 'project', proposed!.id], ['candidate', 'done', 'relationship', null], ['thread', 'done', 'nothing', null]]);
		const [relationship] = await f.tx(sql => sql`select detail from audit_events where action = 'discovery.relationship'`); assert.ok(relationship!.detail.companyId, 'the landlord’s company is named');
		assert.ok(!(await f.tx(sql => activeProjects(sql))).some(p => p.name === 'Cans for October'), 'a proposal is not offered to triage');
		assert.equal(await f.tx(sql => findSeeds(sql, f.org)), 0, 'a seeded candidate waits for new sources');
		// A person accepts: active, its tasks and steps open. The stranger cannot; nor can it be discarded afterwards.
		await assert.rejects(discovery.decide(f.stranger, f.org, proposed!.id, 'accept'));
		assert.deepEqual(await discovery.decide(f.member, f.org, proposed!.id, 'accept'), { projectId: proposed!.id, state: 'active' });
		assert.equal((await f.tx(sql => sql`select state from projects where id = ${proposed!.id}`))[0]!.state, 'active');
		assert.deepEqual((await f.tx(sql => sql`select distinct status from tasks where project_id = ${proposed!.id}`)).map(r => r.status), ['open']);
		await assert.rejects(discovery.decide(f.member, f.org, proposed!.id, 'discard'), { code: 'not_proposed' });
		// Discarding archives the proposal and closes its candidate so it is not proposed again.
		const [again] = await f.tx(sql => sql`insert into projects (organisation_id, name, proposed_at, proposed_by) values (${f.org}, 'City taproom', now(), ${run}) returning id`);
		assert.deepEqual(await discovery.decide(f.member, f.org, String(again!.id), 'discard'), { projectId: String(again!.id), state: 'archived' });
		assert.ok((await f.tx(sql => sql`select closed_at from project_candidates where normalised = 'city taproom'`))[0]!.closedAt);
		assert.equal((await f.tx(sql => sql`select state from projects where id = ${again!.id}`))[0]!.state, 'archived');
	} finally { await f.engine.close(); }
});
