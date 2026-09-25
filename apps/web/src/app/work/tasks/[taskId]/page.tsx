import Link from 'next/link';
import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { Notice } from '../../../../components/Notice.tsx';
import { api, load, type Member } from '../../../../lib/api.ts';
import { describeDue } from '../../../../lib/dates.ts';
import { RecordForm } from '../../RecordForm.tsx';
import { TaskListFeedback } from '../../TaskListFeedback.tsx';
import { ChecklistItem } from '../../ChecklistItem.tsx';
import { TaskFields } from '../../Fields.tsx';
import { offset, type TaskDetail } from '../../records.ts';
import '../../work.css';
import './task-detail.css';
export const metadata={title:'Task'};
const initials=(name:string)=>name.trim().split(/\s+/).slice(0,2).map(w=>w[0]??'').join('').toUpperCase();
export default async function TaskPage({params,searchParams}:{params:Promise<{taskId:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const {taskId}=await params;const href=`/work/tasks/${taskId}`;const me=await requireCurrent(href);const search=await searchParams;
 const paging=new URLSearchParams({checklistOffset:String(offset(search.checklistOffset)),evidenceOffset:String(offset(search.evidenceOffset)),tagOffset:String(offset(search.tagOffset)),limit:'50'});
 const [result,members]=await Promise.all([load(()=>api<TaskDetail>(`/v1/organisations/${me.organisation.organisationId}/tasks/${taskId}?${paging}`,{token:me.token})),load(()=>api<{members:Member[]}>(`/v1/organisations/${me.organisation.organisationId}/members`,{token:me.token}))]);
 if(!result.ok)return <Page title="Task"><Notice title={result.error.status===404?'Task not found':'Task could not be read'} tone="failed" action={{href,label:'Try again'}}>{result.error.message}</Notice><Link href="/work">Back to Work</Link></Page>;
 const d=result.value,t=d.task;const next=(key:string,n:number)=>{const q=new URLSearchParams(paging);q.set(key,String(n));return `${href}?${q}`;};
 const parent=d.parent?{href:`/work/tasks/${d.parent.id}`,label:d.parent.title}:d.series?{href:`/work/series/${d.series.id}`,label:d.series.title}:d.project?{href:`/work/projects/${d.project.id}`,label:d.project.name}:{href:'/work',label:'Work'};
 // The one-tap action flips between complete and reopen with the unchanged status operation; suggested work keeps only the dropdown.
 const primary=t.status==='open'||t.status==='in_progress'?{status:'done',label:'Mark task complete'}:t.status==='done'||t.status==='cancelled'?{status:'open',label:'Reopen task'}:null;
 const context=d.project?.name??d.series?.title??null;
 const evidenceSection=( <section className="task-detail__section"><h2>Evidence</h2>
  {t.evidence.length?<ul className="bare task-detail__evidence">{t.evidence.map(e=><li key={e.id}>{/^https?:\/\//i.test(e.reference)?<a href={e.reference} target="_blank" rel="noopener noreferrer">{e.label||e.reference}</a>:<span>{e.label||e.reference}</span>}</li>)}</ul>:<p className="muted">No evidence on this page.</p>}
  {d.evidenceNextOffset!==null?<Link href={next('evidenceOffset',d.evidenceNextOffset)}>Next evidence</Link>:null}
  <details className="disclosure"><summary>{t.evidence.length?'Add or remove evidence':'Add evidence'}</summary><div className="stack task-detail__forms">
   <RecordForm key={`evidence-${t.revision}`} kind="tasks" id={t.id} revision={t.revision} operation="evidence" label="Add evidence"><label className="field">Source link<input name="reference" type="url" required maxLength={2000}/></label><label className="field">Label<input name="label" maxLength={200}/></label></RecordForm>
   {t.evidence.map(e=><div className="task-detail__remove" key={e.id}><p>{e.label||e.reference}</p><RecordForm kind="tasks" id={t.id} revision={t.revision} operation="remove-evidence" label="Remove evidence"><input type="hidden" name="evidenceId" value={e.id}/></RecordForm></div>)}
  </div></details>
 </section>);
 return <Page title={t.title} parent={parent} eyebrow={<>{t.parentId?'Checklist item':'Task'}{context?` · ${context}`:''}</>}>
 <div className="task-detail">
  <div className="task-detail__tags">{d.tags.items.map(tag=><span className="chip" key={tag.id}>{tag.name}</span>)}{!t.parentId&&(!d.project||d.project.state==='active')?<Link href={`${href}/tags`}>Edit tags</Link>:null}{d.tags.nextOffset!==null?<Link href={next('tagOffset',d.tags.nextOffset)}>More tags</Link>:null}</div>
 <dl className="task-detail__meta">
  <div><dt>Owner</dt><dd>{t.ownerName?<span className="task-detail__owner"><span className="avatar task-detail__initials" aria-hidden="true">{initials(t.ownerName)}</span>{t.ownerName}</span>:(t.ownerId?'Current owner':'No owner')}</dd></div>
  <div><dt>Due</dt><dd className="task-detail__capital">{describeDue(t.due,d.today).text}</dd></div>
  <div><dt>Project</dt><dd>{d.project?<Link className="task-detail__project" href={`/work/projects/${d.project.id}`}>{d.project.name}{d.project.state==='archived'?' (archived)':''}<span aria-hidden="true">›</span></Link>:'No project'}</dd></div>
  <div><dt>Status</dt><dd className="task-detail__capital">{t.status.replaceAll('_',' ')}</dd></div>
 </dl>
 {t.body?<p className="work-record-body">{t.body}</p>:null}{d.series?<p>Recurring work: <Link href={`/work/series/${d.series.id}`}>{d.series.title}</Link></p>:null}
 {(t.evidence.length>0||t.evidenceRequired||offset(search.evidenceOffset)>0)?evidenceSection:null}
 {!t.parentId?<section className="task-detail__section"><h2>Checklist</h2><TaskListFeedback>
  {d.checklist.tasks.length?<ul className="bare work-list task-detail__checklist">{d.checklist.tasks.map(child=><ChecklistItem key={`${child.id}-${child.revision}`} task={child} parentHref={`${href}?${paging}`}/>)}</ul>:<p className="muted">No checklist items on this page.</p>}
  {d.checklist.nextOffset!==null?<Link href={next('checklistOffset',d.checklist.nextOffset)}>Next checklist items</Link>:null}
  <details className="disclosure"><summary>Add checklist item</summary><RecordForm key={`checklist-${t.revision}`} kind="tasks" id={t.id} revision={t.revision} operation="checklist" label="Add checklist item"><label className="field">Checklist item<input name="title" maxLength={200} required/></label></RecordForm></details>
 </TaskListFeedback></section>:null}
 <section className="task-detail__action" aria-label="Task status">
  {primary?<RecordForm key={`primary-${t.revision}`} kind="tasks" id={t.id} revision={t.revision} operation="status" label={primary.label}><input type="hidden" name="status" value={primary.status}/></RecordForm>:null}
  <p className="muted">Completing a task does not confirm an equipment booking.{t.evidenceRequired?' This task requires evidence to complete.':''}</p>
  <details className="disclosure" open={!primary||undefined}><summary>Change status</summary><RecordForm key={`status-${t.revision}`} kind="tasks" id={t.id} revision={t.revision} operation="status" label="Update status"><div className="field"><label htmlFor="task-status">Status</label><select id="task-status" name="status" defaultValue={t.status}>{['open','in_progress','done','cancelled',...(t.status==='suggested'?['suggested']:[])].map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select></div></RecordForm></details>
 </section>
 {!(t.evidence.length>0||t.evidenceRequired||offset(search.evidenceOffset)>0)?evidenceSection:null}
 <details className="disclosure task-detail__edit"><summary>Edit task</summary><RecordForm key={`edit-${t.revision}`} kind="tasks" id={t.id} revision={t.revision}><TaskFields task={t} project={d.project} members={members.ok?members.value.members:null}/></RecordForm></details>
 {Array.from(paging.entries()).some(([key,value])=>key.endsWith('Offset')&&value!=='0')?<Link href={href}>First page of task details</Link>:null}
 </div>
 </Page>;
}
