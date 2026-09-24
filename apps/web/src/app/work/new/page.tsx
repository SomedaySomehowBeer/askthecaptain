import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load, type Commitments, type Member } from '../../../lib/api.ts';
import { NewTaskForm, type OwnerOption, type ProjectOption } from './NewTaskForm.tsx';
import '../work.css';

export const metadata: Metadata = { title: 'New task' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** New task from Work's green plus. The owner starts as the person adding it; a project chosen on
 *  the list arrives as an editable suggestion. Tag assignment controls are a later delivery increment. */
export default async function NewTaskPage({ searchParams }: { searchParams: Promise<{ projectId?: string | string[] }> }) {
	const me = await requireCurrent('/work/new');
	const org = me.organisation.organisationId; const meId = me.me.user.id;
	const { projectId: suggested } = await searchParams;
	const [overview, members] = await Promise.all([
		load(() => api<Commitments>(`/v1/organisations/${org}/commitments`, { token: me.token })),
		load(() => api<{ members: Member[] }>(`/v1/organisations/${org}/members`, { token: me.token }))
	]);
	const owners: OwnerOption[] = [{ id: meId, label: 'You' }, ...(members.ok ? members.value.members : [])
		.filter((m) => m.status === 'active' && m.userId !== meId).map((m) => ({ id: m.userId, label: m.name || m.email }))];
	const active = overview.ok ? overview.value.projects.filter((p) => p.state === 'active') : [];
	const projects: ProjectOption[] | null = overview.ok ? active.map((p) => ({ id: p.id, label: p.systemKind === 'obligations' ? 'Obligations (no project)' : p.name })) : null;
	const wanted = typeof suggested === 'string' && uuid.test(suggested) && active.some((p) => p.id === suggested) ? suggested : undefined;
	const projectId = wanted ?? active.find((p) => p.systemKind === 'obligations')?.id ?? active[0]?.id ?? '';
	return (
		<Page title="New task">
			{!members.ok ? <Notice tone="attention">Other members could not be read ({members.error.message}), so the task can only be yours for now.</Notice> : null}
			{!overview.ok ? <Notice tone="attention">Projects could not be read ({overview.error.message}). A task saved now goes to Obligations; move it on Commitments later.</Notice> : null}
			<section className="card"><NewTaskForm owners={owners} ownerId={meId} projects={projects} projectId={projectId} /></section>
		</Page>
	);
}
