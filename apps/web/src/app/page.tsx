import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '../components/Notice.tsx';
import { Page, requireCurrent } from '../components/Page.tsx';
import { api, load, type Commitments, type Task } from '../lib/api.ts';
import { describeDue } from '../lib/dates.ts';
import { SaveForm } from './commitments/SaveForm.tsx';
import { setTaskStatus } from './commitments/actions.ts';
import { addDays, localDate, type CalendarWeek, type Event } from './calendar/calendar.ts';
import type { MailList } from './inbox/mail.ts';

export const metadata: Metadata = { title: 'Today' };

const greeting = (timeZone: string) => { const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hour12: false }).format(new Date())); return hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening'; };
const timeOf = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const startOfToday = (today: string, timeZone: string) => { for (let h = 0; h < 30; h += 1) { const probe = new Date(`${today}T00:00:00Z`); probe.setUTCHours(probe.getUTCHours() - 14 + h); if (localDate(probe, timeZone) === today && localDate(new Date(probe.getTime() - 3_600_000), timeZone) !== today) return probe.toISOString(); } return `${today}T00:00:00Z`; };

function TaskRow({ task, today }: { task: Task; today: string }) {
	const due = describeDue(task.due, today);
	return (
		<li className="task">
			<div className="task__body"><span className="task__title">{task.title}</span>
				<span className="task__meta">{task.status === 'suggested' ? <span className="chip">suggested</span> : <span className={due.urgency ? `due--${due.urgency}` : undefined}>{due.text}</span>}{task.ownerName ? <span>{task.ownerName}</span> : null}</span></div>
			<span className="task__actions">
				{task.status === 'suggested' ? (<>
					<SaveForm action={setTaskStatus}><input type="hidden" name="id" value={task.id} /><input type="hidden" name="status" value="open" /><button className="button button--secondary button--small" type="submit">Accept</button></SaveForm>
					<SaveForm action={setTaskStatus}><input type="hidden" name="id" value={task.id} /><input type="hidden" name="status" value="cancelled" /><button className="button button--ghost button--small" type="submit">Dismiss</button></SaveForm>
				</>) : <SaveForm action={setTaskStatus}><input type="hidden" name="id" value={task.id} /><input type="hidden" name="status" value="done" /><button className="button button--secondary button--small" type="submit" aria-label={`Mark "${task.title}" done`}>Done</button></SaveForm>}
			</span>
		</li>
	);
}

/** The front page answers one question: does anything need me. It says only what the data can
 *  justify: tasks come from Commitments, events from the synced calendar, mail from the synced inbox;
 *  where a source is not connected it says so rather than showing a quiet day. The brief itself
 *  arrives with the morning-brief workflow. */
export default async function TodayPage() {
	const me = await requireCurrent('/');
	const org = me.organisation.organisationId; const first = me.me.user.name.split(' ')[0] || me.me.user.email;
	const commitments = await load(() => api<Commitments>(`/v1/organisations/${org}/commitments`, { token: me.token }));
	const timezone = commitments.ok ? commitments.value.timezone : 'UTC'; const today = commitments.ok ? commitments.value.today : localDate(new Date(), 'UTC');
	const [calendar, mail] = await Promise.all([
		load(() => api<CalendarWeek>(`/v1/organisations/${org}/calendar/events?from=${today}&to=${addDays(today, 1)}`, { token: me.token })),
		load(() => api<MailList>(`/v1/organisations/${org}/mail/threads?since=${encodeURIComponent(startOfToday(today, timezone))}&limit=100`, { token: me.token }))
	]);
	const tasks = commitments.ok ? commitments.value.tasks : [];
	const open = tasks.filter((t) => t.status === 'open' || t.status === 'in_progress');
	const overdue = open.filter((t) => t.due && describeDue(t.due, today).urgency === 'overdue');
	const dueToday = open.filter((t) => t.due && describeDue(t.due, today).urgency === 'today');
	const suggested = tasks.filter((t) => t.status === 'suggested');
	const needsYou = [...overdue, ...dueToday, ...suggested];
	const events: Event[] = calendar.ok ? calendar.value.events.filter((e) => e.status !== 'cancelled' && (e.allDay ? e.startDate === today : localDate(e.startsAt, timezone) === today)) : [];
	return (
		<Page title={`${greeting(timezone)}, ${first}.`} lede={me.organisation.organisationName}>
			<section className="card" aria-labelledby="needs-you">
				<h2 id="needs-you">Waiting on you</h2>
				{!commitments.ok ? <Notice tone="failed" title="Your commitments could not be read.">{commitments.error.message}</Notice>
					: needsYou.length > 0 ? <ul className="bare">{needsYou.map((task) => <TaskRow key={task.id} task={task} today={today} />)}</ul>
					: <p className="muted">Nothing is overdue, due today or suggested. {open.length > 0 ? `${open.length === 1 ? 'One open task' : `${open.length} open tasks`} have later dates or none.` : 'Add tasks and recurring duties under Commitments.'}</p>}
				<Link className="button button--ghost" href="/commitments">All commitments</Link>
			</section>
			<section className="card" aria-labelledby="today-calendar">
				<h2 id="today-calendar">Today</h2>
				{!calendar.ok ? <Notice tone="failed" title="The calendar could not be read.">{calendar.error.message}</Notice>
					: !calendar.value.connection ? <Notice title="No calendar is connected.">Connect Google in Settings and today’s events appear here.</Notice>
					: calendar.value.connection.status !== 'connected' ? <Notice tone="attention" title="The calendar connection needs attention.">Reconnect Google in Settings → Connections.</Notice>
					: !calendar.value.covered ? <p className="muted">Today has not been synced yet. Sync from the Calendar tab.</p>
					: events.length === 0 ? <p className="muted">No events today.</p>
					: <ul className="bare">{events.map((e) => (
						<li key={e.id} className="line"><span><strong>{e.summary || '(no title)'}</strong><br /><span className="muted">{e.allDay ? 'all day' : `${timeOf(e.startsAt, timezone)} – ${timeOf(e.endsAt, timezone)}`}{e.location ? `, ${e.location}` : ''}{e.attendeeCount > 1 ? `, ${e.attendeeCount} people` : ''}</span></span></li>))}</ul>}
				<Link className="button button--ghost" href="/calendar">This week</Link>
			</section>
			<section className="card" aria-labelledby="today-mail">
				<h2 id="today-mail">Mail</h2>
				{!mail.ok ? <Notice tone="failed" title="Mail could not be read.">{mail.error.message}</Notice>
					: !mail.value.connection ? <Notice title="No mailbox is connected.">Connect Google in Settings and what arrives shows here.</Notice>
					: mail.value.connection.status !== 'connected' ? <Notice tone="attention" title="The mail connection needs attention.">{mail.value.connection.error ?? 'Reconnect Google in Settings → Connections.'}</Notice>
					: !mail.value.lastSync ? <p className="muted">Mail has not been synced yet. Sync from the Inbox tab.</p>
					: <p className="secondary">{mail.value.threads.length === 0 ? 'Nothing new today.' : mail.value.threads.length === 1 ? 'One thread arrived today.' : `${mail.value.threads.length}${mail.value.hasMore ? '+' : ''} threads arrived today.`} Triage says which need you once it is turned on in Settings → Workflows.</p>}
				<Link className="button button--ghost" href="/inbox">Inbox</Link>
			</section>
			<section className="card card--inset" aria-labelledby="brief">
				<h2 id="brief">The brief</h2>
				<p className="secondary">Each morning at 06:30 the brief lands here and on your phone once the morning-brief workflow is turned on. Until then this page is the brief: what is above is everything Captain can say from your data.</p>
			</section>
		</Page>
	);
}
