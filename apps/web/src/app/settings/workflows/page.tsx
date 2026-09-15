import { Suspense } from 'react';
import Link from 'next/link';
import { RunControl } from './RunControl.tsx';
import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load, type OfferedWorkflow, type WorkflowRun, type WorkflowRunDetail, type WorkflowTrigger } from '../../../lib/api.ts';
import { shortDate } from '../../../lib/dates.ts';
import { WorkflowForm } from './WorkflowForm.tsx';

export const metadata: Metadata = { title: 'Workflows' };

const jobs: Record<number, string> = { 1: 'triage the inbox', 2: 'draft correspondence', 3: 'keep the calendar', 4: 'own commitments', 5: 'chase', 6: 'brief and answer' };
const days: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const triggerWords = (trigger: WorkflowTrigger): string =>
	trigger.kind === 'daily' ? `every day at ${trigger.at}` : trigger.kind === 'weekly' ? `every ${days[trigger.day] ?? trigger.day} at ${trigger.at}`
	: trigger.kind === 'event' ? (trigger.event === 'mail.synced' ? 'when mail arrives' : `when ${trigger.event.replace('.', ' ')}`) : 'when you ask';

function stepNote(step: WorkflowRunDetail['steps'][number]) {
 const output = step.output;
 if (!output || typeof output !== 'object') return null;
 if (step.state === 'waiting' && 'wakeAt' in output && typeof output.wakeAt === 'string' && Number.isFinite(Date.parse(output.wakeAt)))
  return `Next check: ${new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(output.wakeAt))} UTC.`;
 if (step.state === 'succeeded' && 'skipped' in output && typeof output.skipped === 'string') return `No action: ${output.skipped.slice(0, 500)}`;
 return 'note' in output && typeof output.note === 'string' ? output.note : null;
}

export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
	const me = await requireCurrent('/settings/workflows');
 return <Suspense fallback={<Page title="Workflows"><p role="status">Reading workflows and activity…</p></Page>}><WorkflowContent me={me} searchParams={searchParams} /></Suspense>;
}
async function WorkflowContent({ me, searchParams }: { me: Awaited<ReturnType<typeof requireCurrent>>; searchParams: Promise<{ run?: string }> }) {
	const org = me.organisation.organisationId; const canManage = me.organisation.role !== 'member';
	const [offered, runs] = await Promise.all([
		load(() => api<{ workflows: OfferedWorkflow[] }>(`/v1/organisations/${org}/workflows`, { token: me.token })),
		load(() => api<{ runs: WorkflowRun[] }>(`/v1/organisations/${org}/workflows/runs?limit=20`, { token: me.token }))
	]);
 const selected = (await searchParams).run;
 const detail = selected ? await load(() => api<WorkflowRunDetail>(`/v1/organisations/${org}/workflows/runs/${encodeURIComponent(selected)}`, { token: me.token })) : null;
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
					{item.runnerProblem ? <Notice tone="quiet" title="Not ready to run.">{item.runnerProblem}</Notice> : null}
     <WorkflowForm offered={item} canManage={canManage} />
     {canManage && item.enablement?.enabled ? <RunControl id={item.definition.key} action="run" disabled={Boolean(item.runnerProblem) || item.unmet.length > 0} /> : null}
				</section>
			))}
			<section className="card" aria-labelledby="activity">
				<h2 id="activity">Activity</h2>
				{!runs.ok ? <Notice tone="failed">{runs.error.message}</Notice> : runs.value.runs.length === 0 ? (
					<p className="muted">No runs yet. Turn on a ready workflow to begin. Each run and its steps will appear here.</p>
				) : (
					<ul className="bare">{runs.value.runs.map((run) => (
						<li key={run.id} className="line"><span><Link href={`/settings/workflows?run=${run.id}`}><strong>{run.definitionKey}</strong></Link><br /><span className="muted">{run.state}{run.reason ? `: ${run.reason}` : ''}</span></span><span className="muted">{shortDate(run.createdAt.slice(0, 10))}</span></li>
					))}</ul>
				)}
   {detail ? !detail.ok ? <Notice tone="failed" title="The run could not be read.">{detail.error.message}</Notice> : <section aria-labelledby="run-detail">
     <h3 id="run-detail">{detail.value.definitionKey} · version {detail.value.definitionVersion}</h3>
     <p>{detail.value.state}{detail.value.reason ? `: ${detail.value.reason}` : ''}</p>
     {detail.value.steps.length ? <ol>{detail.value.steps.map(step => <li key={step.path}><strong>{step.key}</strong>{step.itemIndex === null ? '' : ` · item ${step.itemIndex + 1}`} — {step.state}{step.error ? <p className="form__error">{step.error}</p> : null}{stepNote(step) ? <p className="muted">{stepNote(step)}</p> : null}</li>)}</ol> : <p className="muted">No steps have started yet.</p>}
     {canManage ? <div className="row">{detail.value.state === 'paused' ? <RunControl id={detail.value.id} action="resume" /> : null}{!['succeeded', 'failed', 'cancelled'].includes(detail.value.state) ? <RunControl id={detail.value.id} action="cancel" /> : null}</div> : <p className="muted">Owners and admins resume or cancel runs.</p>}
    </section> : null}
			</section>
		</Page>
	);
}
