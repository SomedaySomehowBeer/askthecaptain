import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load, type OfferedWorkflow, type WorkflowRun, type WorkflowTrigger } from '../../../lib/api.ts';
import { shortDate } from '../../../lib/dates.ts';
import { WorkflowForm } from './WorkflowForm.tsx';

export const metadata: Metadata = { title: 'Workflows' };

const jobs: Record<number, string> = { 1: 'triage the inbox', 2: 'draft correspondence', 3: 'keep the calendar', 4: 'own commitments', 5: 'chase', 6: 'brief and answer' };
const days: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const triggerWords = (trigger: WorkflowTrigger): string =>
	trigger.kind === 'daily' ? `every day at ${trigger.at}` : trigger.kind === 'weekly' ? `every ${days[trigger.day] ?? trigger.day} at ${trigger.at}`
	: trigger.kind === 'event' ? (trigger.event === 'mail.synced' ? 'when mail arrives' : `when ${trigger.event.replace('.', ' ')}`) : 'when you ask';

export default async function WorkflowsPage() {
	const me = await requireCurrent('/settings/workflows');
	const org = me.organisation.organisationId; const canManage = me.organisation.role !== 'member';
	const [offered, runs] = await Promise.all([
		load(() => api<{ workflows: OfferedWorkflow[] }>(`/v1/organisations/${org}/workflows`, { token: me.token })),
		load(() => api<{ runs: WorkflowRun[] }>(`/v1/organisations/${org}/workflows/runs?limit=20`, { token: me.token }))
	]);
	return (
		<Page title="Workflows" lede="What Captain does for you, and on whose say-so. Turning one on is the authorisation: it acts in your name and can do nothing you could not.">
			{!offered.ok ? <Notice tone="failed" title="The workflows could not be read.">{offered.error.message}</Notice> : offered.value.workflows.map((item) => (
				<section className="card" key={item.definition.key} aria-labelledby={`wf-${item.definition.key}`}>
					<div className="row row--between">
						<h2 id={`wf-${item.definition.key}`}>{item.definition.name}</h2>
						<span className="chip">{item.enablement?.enabled ? 'on' : 'off'}</span>
					</div>
					<p className="secondary">{item.definition.description}</p>
					<p className="muted">Runs {item.definition.triggers.map(triggerWords).join(', and ')}. Moves “{jobs[item.definition.job]}” sooner.
						{item.enablement?.enabled && item.enablement.enabledByName ? ` On since ${shortDate(item.enablement.updatedAt.slice(0, 10))}, in ${item.enablement.enabledByName}'s name.` : ''}</p>
					{item.unmet.length > 0 ? <Notice tone={item.enablement?.enabled ? 'attention' : 'quiet'} title={item.enablement?.enabled ? 'This workflow cannot run right now.' : 'Not ready to turn on yet.'}>It needs {item.unmet.map((u) => u.words).join(' and ')}.</Notice> : null}
					<WorkflowForm offered={item} canManage={canManage} />
				</section>
			))}
			<section className="card" aria-labelledby="activity">
				<h2 id="activity">Activity</h2>
				{!runs.ok ? <Notice tone="failed">{runs.error.message}</Notice> : runs.value.runs.length === 0 ? (
					<p className="muted">No runs yet. The journal of every run and each of its steps appears here once the workflow runner ships.</p>
				) : (
					<ul className="bare">{runs.value.runs.map((run) => (
						<li key={run.id} className="line"><span><strong>{run.definitionKey}</strong><br /><span className="muted">{run.state}{run.reason ? `: ${run.reason}` : ''}</span></span><span className="muted">{shortDate(run.createdAt.slice(0, 10))}</span></li>
					))}</ul>
				)}
			</section>
		</Page>
	);
}
