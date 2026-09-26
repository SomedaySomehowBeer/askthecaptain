import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load, type Project } from '../../../lib/api.ts';
import type { Options, TaskDetail } from '../../work/records.ts';
import { readMembers } from '../actions.ts';
import { isUuid, type LinkKind } from '../types.ts';
import { NewConversationForm, type ChosenLink } from './NewConversationForm.tsx';
import '../chat-list.css';

export const metadata: Metadata = { title: 'New conversation' };

/** `?link=task:<id>` or `?link=project:<id>`, sent once; anything else is not a link. */
function suggestedLink(raw: string | string[] | undefined): { kind: LinkKind; targetId: string } | 'none' | 'invalid' {
	if (raw === undefined) return 'none';
	if (typeof raw !== 'string') return 'invalid';
	const match = /^(task|project):(.+)$/.exec(raw);
	if (!match || !isUuid(match[2])) return 'invalid';
	return { kind: match[1] as LinkKind, targetId: match[2]!.toLowerCase() };
}

/** New conversation, from the green plus on the list or views, or from a task or project with that item suggested as
 *  an editable, removable link. The suggestion is read through the normal Work API before it is offered. */
export default async function NewConversationPage({ searchParams }: { searchParams: Promise<{ link?: string | string[] }> }) {
	const wanted = suggestedLink((await searchParams).link);
	const here = typeof wanted === 'object' ? `/chat/new?${new URLSearchParams({ link: `${wanted.kind}:${wanted.targetId}` })}` : '/chat/new';
	const me = await requireCurrent(here);
	const org = me.organisation.organisationId; const meId = me.me.user.id.toLowerCase();
	const scope = { userId: me.me.user.id, organisationId: org };
	const [members, options, target] = await Promise.all([
		readMembers(scope),
		load(() => api<Options>(`/v1/organisations/${org}/work/options?limit=50`, { token: me.token })),
		typeof wanted === 'object'
			? wanted.kind === 'task'
				? load(() => api<TaskDetail>(`/v1/organisations/${org}/tasks/${wanted.targetId}`, { token: me.token })).then((r) => r.ok ? { ok: true as const, label: r.value.task.title } : r)
				: load(() => api<Project>(`/v1/organisations/${org}/projects/${wanted.targetId}`, { token: me.token })).then((r) => r.ok ? { ok: true as const, label: r.value.name } : r)
			: Promise.resolve(null)
	]);
	const initial: ChosenLink | null = typeof wanted === 'object' && target?.ok ? { ...wanted, label: target.label } : null;
	const linkProblem = wanted === 'invalid' ? 'The task or project in this link could not be read, so nothing is linked yet. Choose one below if you want to.'
		: typeof wanted === 'object' && target && !target.ok ? `That ${wanted.kind} could not be used (${target.error.message}), so nothing is linked yet. Choose a task or project below if you want to.` : null;
	const others = members.ok ? members.value.filter((m) => m.userId !== meId) : null;
	const parent = initial ? { href: initial.kind === 'task' ? `/work/tasks/${initial.targetId}` : `/work/projects/${initial.targetId}`, label: initial.label } : { href: '/chat', label: 'Chat' };

	return (
		<Page title="New conversation" parent={parent}>
			{linkProblem ? <Notice tone="attention">{linkProblem}</Notice> : null}
			{!members.ok ? <Notice tone="attention">Members could not be read ({members.error}), so nobody else can be added yet. You can start the conversation and add people later from its details.</Notice> : null}
			{!options.ok ? <Notice tone="attention">Tasks and projects could not be listed ({options.error.message}). Search still works, and a link is optional.</Notice> : null}
			<section className="card">
				<NewConversationForm scope={scope} members={others} initialLink={initial}
					tasks={options.ok ? options.value.tasks.items.map(({ id, label }) => ({ id, label })) : null}
					projects={options.ok ? options.value.projects.items : null} />
			</section>
		</Page>
	);
}
