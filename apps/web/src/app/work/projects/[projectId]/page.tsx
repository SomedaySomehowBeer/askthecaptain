import Link from 'next/link';
import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { Notice } from '../../../../components/Notice.tsx';
import { api, load, type Project, type Member, type Organisation, type Loaded } from '../../../../lib/api.ts';
import { RecordForm } from '../../RecordForm.tsx';
import { ProjectFields } from '../../Fields.tsx';
import type { WorkPage } from '../../types.ts';
import { offset } from '../../records.ts';
import { todayInZone, shiftDate, zonedDay } from '../../../resources/equipment/time.ts';
import { ProjectTasks, initials } from './ProjectTasks.tsx';
import { ProjectBookings, type ProjectReservationPage, type ProjectWindow } from './ProjectBookings.tsx';
import '../../work.css';
import './project.css';

export const metadata = { title: 'Project' };

async function preview(root: string, projectId: string, token: string): Promise<Loaded<WorkPage>> {
 const pages = await Promise.all(['open', 'in_progress'].map(status => load(() => api<WorkPage>(`${root}/tasks?projectId=${projectId}&status=${status}&limit=6`, { token }))));
 const failure = pages.find(page => !page.ok);
 if (failure && !failure.ok) return failure;
 const tasks = pages.flatMap(page => page.ok ? page.value.tasks : []).sort((a,b) => {
  if (a.due !== b.due) return a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
 });
 return { ok: true, value: { tasks: tasks.slice(0,6), nextOffset: tasks.length > 6 || pages.some(page => page.ok && page.value.nextOffset !== null) ? 6 : null } };
}
export default async function ProjectPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
 const { projectId } = await params, href = `/work/projects/${projectId}`, me = await requireCurrent(href), s = await searchParams;
 const view = s.view === 'tasks' || s.view === 'schedule' ? s.view : s.status === 'cancelled' || s.offset !== undefined ? 'tasks' : 'overview';
 const status = s.status === 'in_progress' || s.status === 'suggested' || s.status === 'done' || s.status === 'cancelled' || s.status === 'all' ? s.status : 'open';
 const start = offset(s.offset), root = `/v1/organisations/${me.organisation.organisationId}`;
 const [result, members, organisation] = await Promise.all([
  load(() => api<Project>(`${root}/projects/${projectId}`, { token: me.token })),
  load(() => api<{ members: Member[] }>(`${root}/members`, { token: me.token })),
  load(() => api<Organisation>(root, { token: me.token }))
 ]);
 if (!result.ok) return <Page title="Project" parent={{ href: '/work/projects', label: 'Projects' }}><Notice tone="failed" title="Project could not be read" action={{ href, label: 'Try again' }}>{result.error.message}</Notice></Page>;
 const p = result.value, overview = view === 'overview', owners = new Map((members.ok ? members.value.members : []).map(m => [m.userId, m.name || m.email]));
 const owner = p.ownerId ? owners.get(p.ownerId) : null;
 let window: ProjectWindow | null = null, problem: string | null = null, today: string | null = null;
 try {
  if (!organisation.ok) throw new Error('The business time zone could not be read. Refresh to try again.');
  const zone = organisation.value.timezone;
  today = todayInZone(zone);
  const date = overview || s.date === undefined ? today : typeof s.date === 'string' ? s.date : '';
  const span = overview || s.span === undefined ? 14 : typeof s.span === 'string' && /^(1|7|14|28)$/.test(s.span) ? Number(s.span) : NaN;
  if (!Number.isFinite(span)) throw new Error('Choose a 1, 7, 14 or 28 day window.');
  window = { date, span, from: zonedDay(date, zone), to: zonedDay(shiftDate(date, span), zone), zone };
 } catch (error) { problem = error instanceof Error ? error.message : 'Choose a valid schedule date.'; }
 const [tasks, bookings] = await Promise.all([
  overview ? preview(root, projectId, me.token) : view === 'tasks' ? load(() => api<WorkPage>(`${root}/tasks?projectId=${projectId}${status === 'all' ? '' : `&status=${status}`}&offset=${start}&limit=50`, { token: me.token })) : null,
  view !== 'tasks' && window ? load(() => api<ProjectReservationPage>(`${root}/projects/${projectId}/reservations?${new URLSearchParams({ from: window.from, to: window.to, offset: String(overview ? 0 : start), limit: overview ? '3' : '50' })}`, { token: me.token })) : null
 ]);
 return <Page title={p.name} parent={{ href: `/work/projects${p.state === 'archived' ? '?state=archived' : ''}`, label: 'Projects' }}>
  <div className="project-context"><span className="avatar project-owner" aria-hidden="true">{owner ? initials(owner) : '–'}</span><span>{owner ? `${owner} owns this` : p.ownerId ? (members.ok ? 'Former member owns this' : 'Owner details unavailable') : 'No project owner'} · {p.state} · {p.stage}</span></div>
  <nav className="project-tabs" aria-label="Project views">{(['overview', 'tasks', 'schedule'] as const).map(tab => <Link key={tab} href={tab === 'overview' ? href : `${href}?view=${tab}`} aria-current={view === tab ? 'page' : undefined}>{tab[0]!.toUpperCase() + tab.slice(1)}</Link>)}</nav>
  {overview && p.description ? <p className="work-record-body project-description">{p.description}</p> : null}
  {!members.ok && view !== 'schedule' ? <Notice tone="failed" title="People could not be read">Owner names are unavailable. Refresh to try again.</Notice> : null}
  {tasks ? <ProjectTasks result={tasks} href={href} overview={overview} start={start} status={status} owners={owners} peopleAvailable={members.ok} today={today}/> : null}
  {view !== 'tasks' ? <ProjectBookings result={bookings} window={window} problem={problem} invalidWindow={organisation.ok} href={href} overview={overview} start={start}/> : null}
  <details className="project-actions"><summary>Project actions</summary><div className="stack"><Link href={`/work/series?projectId=${p.id}`}>Recurring work in this project</Link>{p.state === 'active' ? <><Link href={`/work/new?projectId=${p.id}`}>New task</Link><Link href={`/work/series/new?projectId=${p.id}`}>New recurring work</Link></> : null}</div></details>
  <details className="project-edit"><summary>Edit project</summary><RecordForm kind="projects" id={p.id} revision={p.revision} key={p.revision}><ProjectFields project={p}/></RecordForm></details>
  {p.state === 'active' ? <Link className="work-plus" href={`/work/new?projectId=${p.id}`} aria-label="New task in this project">+</Link> : null}
 </Page>;
}
