import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { MailService } from './service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { NotesService } from '../notes/service.ts';
import { triageFixture } from '../../test/triage-fixture.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });

it('a person links a thread to a project; the thread, the list and Commitments show it; Obligations and archived projects are refused', async () => {
	const f = await triageFixture(db); try {
		const mail = new MailService(db.app); const commitments = new CommitmentsService(db.app);
		const threadId = await f.mail('cans-1', 'sam@canco.test', 'Artwork for the October cans is attached.');
		const cans = await commitments.createProject(f.actor, f.org, { name: 'Cans for October' });
		const parked = await commitments.createProject(f.actor, f.org, { name: 'Parked' }); await commitments.updateProject(f.actor, f.org, parked.id, { archived: true } as never);
		// Before any link: nothing shown, the active non-system projects offered.
		const unlinked = await mail.thread(f.member, f.org, threadId);
		assert.equal(unlinked.projects.length, 0); assert.deepEqual(unlinked.projectOptions.map(p => p.name), ['Cans for October']);
		assert.equal((await mail.list(f.member, f.org)).threads[0]!.projectName, null);
		// A member may link; the link is theirs and carries the counterparty's company.
		await mail.linkProject(f.member, f.org, threadId, cans.id);
		const linked = await mail.thread(f.member, f.org, threadId);
		assert.deepEqual(linked.projects.map(p => [p.name, p.linkedBy, p.rule]), [['Cans for October', 'person', null]]);
		const [row] = await f.tx(sql => sql`select linked_by_id, company_id from project_sources where source_id = ${threadId}`);
		assert.equal(row!.linkedById, f.member.userId); assert.ok(row!.companyId, 'the sender company is recorded so the company rule can read it');
		assert.equal((await mail.list(f.member, f.org)).threads[0]!.projectName, 'Cans for October');
		const overview = await commitments.overview(f.member, f.org);
		assert.deepEqual(overview.links.map(l => [l.projectId, l.kind, l.id, l.title, l.linkedBy, l.total]), [[cans.id, 'mail_thread', threadId, 'Delivery update', 'person', 1]]);
		assert.ok(overview.links[0]!.at instanceof Date);
		// Obligations (which the first read created) and an archived project are not choices.
		const [obligations] = await f.tx(sql => sql`select id from projects where system_kind = 'obligations'`);
		await assert.rejects(mail.linkProject(f.member, f.org, threadId, String(obligations!.id)), { code: 'project_unavailable' });
		await assert.rejects(mail.linkProject(f.member, f.org, threadId, parked.id), { code: 'project_unavailable' });
		// A note a person filed under the project sits beside the thread, newest link first.
		const notes = new NotesService(db.app, null);
		const note = await notes.create(f.actor, f.org, { title: 'Canning call', body: 'Agreed the artwork is final by Friday.', projectId: cans.id });
		const both = (await commitments.overview(f.member, f.org)).links;
		assert.deepEqual(both.map(l => [l.kind, l.id, l.title, l.total]), [['note', note.id, 'Canning call', 2], ['mail_thread', threadId, 'Delivery update', 2]]);
		// Choosing no project removes the link and is audited; the stranger cannot touch it.
		const cleared = await mail.linkProject(f.member, f.org, threadId, null); assert.deepEqual(cleared, { projectId: null, replaced: [cans.id] });
		assert.equal((await mail.thread(f.member, f.org, threadId)).projects.length, 0);
		const actions = await f.tx(sql => sql`select action from audit_events where subject_id = ${threadId} and action like 'project.%' order by created_at`);
		assert.deepEqual(actions.map(a => a.action), ['project.linked', 'project.unlinked']);
		await assert.rejects(mail.linkProject(f.stranger, f.org, threadId, cans.id));
	} finally { await f.engine.close(); }
});
