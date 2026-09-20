import type { TransactionSql } from '@captain/db';
import { addresses } from '../contacts/addresses.ts';
import { journal, normaliseProjectName, type Context, type ProjectLink, type Thread, type Triage } from './data.ts';
/** Association (D22), rules first: an existing link, a counterparty company linked to exactly one active project, or a
 *  reference that matches a task links the thread without the model. Only projects a person made count; Obligations never. */
export async function projectRule(tx: TransactionSql, thread: Thread): Promise<ProjectLink> {
	const sender = addresses(thread.messages.find(m => addresses(m.fromHeader)[0]?.email === thread.sender)?.fromHeader ?? '')[0]?.email ?? thread.sender;
	const [contact] = await tx`select c.company_id from contacts c where c.email = ${sender} and c.archived_at is null and c.company_id is not null limit 1`;
	const companyId = contact?.companyId ? String(contact.companyId) : null;
	const [existing] = await tx`select ps.project_id, p.name from project_sources ps join projects p on p.organisation_id = ps.organisation_id and p.id = ps.project_id
		where ps.source_kind = 'mail_thread' and ps.source_id = ${thread.id} and p.archived_at is null order by ps.created_at limit 1`;
	if (existing) return { projectId: String(existing.projectId), projectName: String(existing.name), rule: 'existing_link', companyId };
	if (companyId) {
		const projects = await tx`select distinct p.id, p.name from project_sources ps join projects p on p.organisation_id = ps.organisation_id and p.id = ps.project_id
			where ps.company_id = ${companyId} and p.archived_at is null and p.system_kind is null`;
		if (projects.length === 1) return { projectId: String(projects[0]!.id), projectName: String(projects[0]!.name), rule: 'company', companyId };
	}
	// A task's reference (its body) quoted in the thread: exact text, no fuzzy matching.
	const text = thread.messages.map(m => m.body).join('\n');
	const referenced = await tx`select distinct p.id, p.name from tasks t join projects p on p.organisation_id = t.organisation_id and p.id = t.project_id
		where p.archived_at is null and p.system_kind is null and t.status <> 'cancelled' and length(t.body) >= 4 and position(t.body in ${text}) > 0`;
	if (referenced.length === 1) return { projectId: String(referenced[0]!.id), projectName: String(referenced[0]!.name), rule: 'task_reference', companyId };
	return { projectId: null, projectName: null, rule: null, companyId };
}
/** The active projects the model may name: most recently active first, at most fifty, never Obligations. */
export async function activeProjects(tx: TransactionSql): Promise<{ name: string; description: string }[]> {
	const rows = await tx`select name, left(description, 300) as description from projects where archived_at is null and system_kind is null order by updated_at desc, name limit 50`;
	return rows.map(r => ({ name: String(r.name), description: String(r.description) }));
}
export type Source = { kind: 'mail_thread' | 'note'; id: string; own: boolean; companyId?: string | null };
/** Writes the association a run decided: the rule's link, the model's link to a name that exists, or a candidate. */
export async function recordAssociation(context: Context, source: Source, link: ProjectLink | null, project: Triage['project']): Promise<string | null> {
	const { tx } = context;
	const write = async (projectId: string, linkedBy: 'rule' | 'model' | 'person', rule: string | null) => {
		const added = await tx`insert into project_sources (organisation_id, project_id, source_kind, source_id, linked_by, linked_by_id, rule, company_id)
			values (${context.organisationId}, ${projectId}, ${source.kind}, ${source.id}, ${linkedBy}, ${linkedBy === 'person' ? null : context.runId}, ${rule}, ${source.companyId ?? null}) on conflict do nothing returning project_id`;
		if (added.length) await journal(context, 'project.linked', source.kind, source.id, { projectId, linkedBy, rule });
		return projectId;
	};
	// A link the person made (a note's project) is theirs; the rules' links and the model's carry the run.
	if (link?.projectId) return write(link.projectId, link.rule === 'person_link' ? 'person' : 'rule', link.rule);
	const name = project.name?.trim(); if (!name) return null;
	const normalised = normaliseProjectName(name); if (!normalised) return null;
	const [match] = await tx`select id from projects where archived_at is null and system_kind is null and lower(regexp_replace(name, '[^[:alnum:]]+', ' ', 'g')) = ${normalised} limit 1`;
	if (match) return write(String(match.id), 'model', null);
	await tx`insert into project_candidates (organisation_id, normalised, name, stage) values (${context.organisationId}, ${normalised}, ${name.slice(0, 200)}, ${project.stage ?? 'underway'})
		on conflict (organisation_id, normalised) do update set last_seen_at = now(), stage = case when excluded.stage = 'underway' then 'underway' else project_candidates.stage end`;
	const seen = await tx`insert into project_candidate_sources (organisation_id, normalised, source_kind, source_id, own) values (${context.organisationId}, ${normalised}, ${source.kind}, ${source.id}, ${source.own}) on conflict do nothing returning normalised`;
	if (seen.length) await journal(context, 'project.candidate', source.kind, source.id, { normalised, stage: project.stage ?? 'underway' });
	return null;
}
