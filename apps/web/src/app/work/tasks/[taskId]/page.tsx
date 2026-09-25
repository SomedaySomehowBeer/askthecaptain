import Link from 'next/link';
import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { Notice } from '../../../../components/Notice.tsx';
import { api, load, type Member } from '../../../../lib/api.ts';
import { describeDue } from '../../../../lib/dates.ts';
import { RecordForm } from '../../RecordForm.tsx';
import { ChecklistItem } from '../../ChecklistItem.tsx';
import { TaskFields } from '../../Fields.tsx';
import { offset, type TaskDetail } from '../../records.ts';
import '../../work.css';
export const metadata={title:'Task'};
export default async function TaskPage({params,searchParams}:{params:Promise<{taskId:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const {taskId}=await params;const href=`/work/tasks/${taskId}`;const me=await requireCurrent(href);const search=await searchParams;
 const paging=new URLSearchParams({checklistOffset:String(offset(search.checklistOffset)),evidenceOffset:String(offset(search.evidenceOffset)),tagOffset:String(offset(search.tagOffset)),limit:'50'});
 const [result,members]=await Promise.all([load(()=>api<TaskDetail>(`/v1/organisations/${me.organisation.organisationId}/tasks/${taskId}?${paging}`,{token:me.token})),load(()=>api<{members:Member[]}>(`/v1/organisations/${me.organisation.organisationId}/members`,{token:me.token}))]);
 if(!result.ok)return <Page title="Task"><Notice title={result.error.status===404?'Task not found':'Task could not be read'} tone="failed" action={{href,label:'Try again'}}>{result.error.message}</Notice><Link href="/work">Back to Work</Link></Page>;
 const d=result.value,t=d.task;const next=(key:string,n:number)=>{const q=new URLSearchParams(paging);q.set(key,String(n));return `${href}?${q}`;};
 const parent=d.parent?{href:`/work/tasks/${d.parent.id}`,label:d.parent.title}:d.series?{href:`/work/series/${d.series.id}`,label:d.series.title}:d.project?{href:`/work/projects/${d.project.id}`,label:d.project.name}:{href:'/work',label:'Work'};
 return <Page title={t.title} parent={parent}>
 <div className="row">{d.tags.items.map(tag=><span className="chip" key={tag.id}>{tag.name}</span>)}{!t.parentId&&(!d.project||d.project.state==='active')?<Link href={`${href}/tags`}>Edit tags</Link>:null}{d.tags.nextOffset!==null?<Link href={next('tagOffset',d.tags.nextOffset)}>More tags</Link>:null}</div>
 <section className="card"><dl className="work-record-meta"><div><dt>Owner</dt><dd>{t.ownerName??(t.ownerId?'Current owner':'No owner')}</dd></div><div><dt>Due</dt><dd>{describeDue(t.due,d.today).text}</dd></div><div><dt>Project</dt><dd>{d.project?<Link href={`/work/projects/${d.project.id}`}>{d.project.name}{d.project.state==='archived'?' (archived)':''}</Link>:'No project'}</dd></div><div><dt>Status</dt><dd>{t.status.replaceAll('_',' ')}</dd></div></dl></section>
 {t.body?<p className="work-record-body">{t.body}</p>:null}{d.series?<p>Recurring work: <Link href={`/work/series/${d.series.id}`}>{d.series.title}</Link></p>:null}
 <section className="card stack"><h2>Status</h2><RecordForm key={`status-${t.revision}`} kind="tasks" id={t.id} revision={t.revision} operation="status" label="Update status"><div className="field"><label htmlFor="task-status">Status</label><select id="task-status" name="status" defaultValue={t.status}>{['open','in_progress','done','cancelled',...(t.status==='suggested'?['suggested']:[])].map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select></div></RecordForm><p className="muted">Completing a task does not confirm an equipment booking.{t.evidenceRequired?' This task requires evidence to complete.':''}</p></section>
 {!t.parentId?<section className="card stack"><h2>Checklist</h2>{d.checklist.tasks.length?<ul className="bare work-list">{d.checklist.tasks.map(child=><ChecklistItem key={`${child.id}-${child.revision}`} task={child} parentHref={`${href}?${paging}`}/>)}</ul>:<p>No checklist items on this page.</p>}{d.checklist.nextOffset!==null?<Link href={next('checklistOffset',d.checklist.nextOffset)}>Next checklist items</Link>:null}<RecordForm key={`checklist-${t.revision}`} kind="tasks" id={t.id} revision={t.revision} operation="checklist" label="Add checklist item"><label className="field">Checklist item<input name="title" maxLength={200} required/></label></RecordForm></section>:null}
 <section className="card stack"><h2>Evidence</h2>{t.evidence.length?t.evidence.map(e=><article className="stack" key={e.id}>{/^https?:\/\//i.test(e.reference)?<a href={e.reference} target="_blank" rel="noopener noreferrer">{e.label||e.reference}</a>:<p>{e.label||e.reference}</p>}<RecordForm kind="tasks" id={t.id} revision={t.revision} operation="remove-evidence" label="Remove evidence"><input type="hidden" name="evidenceId" value={e.id}/></RecordForm></article>):<p>No evidence on this page.</p>}{d.evidenceNextOffset!==null?<Link href={next('evidenceOffset',d.evidenceNextOffset)}>Next evidence</Link>:null}<RecordForm key={`evidence-${t.revision}`} kind="tasks" id={t.id} revision={t.revision} operation="evidence" label="Add evidence"><label className="field">Source link<input name="reference" type="url" required maxLength={2000}/></label><label className="field">Label<input name="label" maxLength={200}/></label></RecordForm></section>
 <section className="card"><details><summary>Edit task</summary><RecordForm key={`edit-${t.revision}`} kind="tasks" id={t.id} revision={t.revision}><TaskFields task={t} project={d.project} members={members.ok?members.value.members:null}/></RecordForm></details></section>
 {Array.from(paging.entries()).some(([key,value])=>key.endsWith('Offset')&&value!=='0')?<Link href={href}>First page of task details</Link>:null}
 </Page>;
}
