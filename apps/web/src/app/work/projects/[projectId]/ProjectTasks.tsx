import Link from 'next/link';
import { Notice } from '../../../../components/Notice.tsx';
import type { Loaded } from '../../../../lib/api.ts';
import { describeDue, shortDate } from '../../../../lib/dates.ts';
import { TaskCheckRow } from '../../ChecklistItem.tsx';
import { TaskListFeedback } from '../../TaskListFeedback.tsx';
import type { WorkPage } from '../../types.ts';

export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(word => word[0] ?? '').join('').toUpperCase();

export function ProjectTasks({ result, href, overview, start, cancelled, owners, peopleAvailable, today }: {
 result: Loaded<WorkPage>; href: string; overview: boolean; start: number; cancelled: boolean;
 owners: Map<string, string>; peopleAvailable: boolean; today: string | null;
}) {
 const listHref = `${href}?view=tasks${cancelled ? '&status=cancelled' : ''}`;
 const returnHref = overview ? href : `${listHref}&offset=${start}`;
 return <section className="project-section" aria-label={overview ? 'Across the project' : 'Project tasks'}>
  <div className="project-section__heading"><h2>{overview ? 'Across the project' : 'Tasks'}</h2>{overview ? <Link href={listHref}>All tasks <span aria-hidden="true">›</span></Link> : null}</div>
  {!overview ? <nav className="project-task-filters" aria-label="Task history"><Link href={`${href}?view=tasks`} aria-current={!cancelled ? 'page' : undefined}>Current and completed tasks</Link><Link href={`${href}?view=tasks&status=cancelled`} aria-current={cancelled ? 'page' : undefined}>Cancelled tasks</Link></nav> : null}
  {overview ? <p className="project-note">Open and in-progress work · earliest due first</p> : null}
  <TaskListFeedback>
   {!result.ok ? <Notice title="Tasks could not be read" tone="failed" action={{ href: returnHref, label: 'Try again' }}>{result.error.message}</Notice> : <>
    {result.value.tasks.length ? <ul className={`bare work-list work-list--card ${overview ? 'project-stream' : ''}`}>
     {result.value.tasks.map(task => {
      const owner = task.ownerId ? owners.get(task.ownerId) : undefined;
      const ownerLabel = owner ?? (task.ownerId ? (peopleAvailable ? 'Former member' : 'Owner details unavailable') : 'No owner');
      const due = task.due ? (task.status === 'done' || task.status === 'cancelled' || !today ? shortDate(task.due) : describeDue(task.due, today).text) : 'No date';
      return overview ? <li key={task.id}><Link href={`/work/tasks/${task.id}`} className="project-stream__link">
       <span className="project-stream__mark" aria-hidden="true">{task.tags[0]?.name.slice(0, 1).toUpperCase() ?? '•'}</span>
       <span className="project-stream__text"><strong>{task.tags.map(tag => tag.name).join(' · ') || 'Untagged work'}</strong><span>{task.title} · {due}{task.status !== 'open' ? ` · ${task.status.replaceAll('_', ' ')}` : ''}</span></span>
       <span className="avatar project-owner" role="img" aria-label={ownerLabel} title={ownerLabel}>{owner ? initials(owner) : '–'}</span>
      </Link></li> : <TaskCheckRow key={`${task.id}-${task.revision}`} task={task} parentHref={returnHref} variant="task">
       <span className="work-task__heading"><span className="work-task__title">{task.title}</span>{task.due ? <time className="work-task__due" dateTime={task.due} title={`Due ${task.due}`}>{shortDate(task.due)}</time> : null}</span>
       <span className="work-task__meta">{task.tags.map(tag => <span className="chip" key={tag.id}>{tag.name}</span>)}<span>{ownerLabel}</span><span>{task.status.replaceAll('_', ' ')}</span></span>
      </TaskCheckRow>;
     })}
    </ul> : <p className="project-empty">{overview ? 'No open or in-progress tasks in this project.' : 'No tasks on this page.'}</p>}
    {overview && result.value.nextOffset !== null ? <p className="project-note">Showing the first six open or in-progress tasks by due date. <Link href={listHref}>View all project tasks</Link>.</p> : null}
    {!overview ? <nav className="row" aria-label="Task pages">{start > 0 ? <Link href={`${listHref}&offset=${Math.max(0, start - 50)}`}>Previous tasks</Link> : null}{result.value.nextOffset !== null ? <Link href={`${listHref}&offset=${result.value.nextOffset}`}>Next tasks</Link> : null}</nav> : null}
   </>}
  </TaskListFeedback>
 </section>;
}
