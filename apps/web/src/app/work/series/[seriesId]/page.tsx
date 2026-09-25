import Link from 'next/link';
import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { Notice } from '../../../../components/Notice.tsx';
import { api, load, type Member, type Project, type Series } from '../../../../lib/api.ts';
import { RecordForm } from '../../RecordForm.tsx';
import { SeriesFields } from '../../Fields.tsx';
import { TaskList } from '../../RecordLists.tsx';
import type { WorkPage } from '../../types.ts';
import { offset } from '../../records.ts';
import '../../work.css';
export default async function SeriesPage({params,searchParams}:{params:Promise<{seriesId:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const {seriesId}=await params;const href=`/work/series/${seriesId}`;const me=await requireCurrent(href);const s=await searchParams;const start=offset(s.offset);const state=s.status==='cancelled'?'cancelled':'all';const root=`/v1/organisations/${me.organisation.organisationId}`;
 const [result,members,tasks]=await Promise.all([load(()=>api<Series>(`${root}/series/${seriesId}`,{token:me.token})),load(()=>api<{members:Member[]}>(`${root}/members`,{token:me.token})),load(()=>api<WorkPage>(`${root}/tasks?seriesId=${seriesId}${state==='cancelled'?'&status=cancelled':''}&offset=${start}&limit=50`,{token:me.token}))]);
 if(!result.ok)return <Page title="Recurring work"><Notice tone="failed">{result.error.message}</Notice><Link href="/work/series">Recurring work</Link></Page>;
 const r=result.value;const project=r.projectId?await load(()=>api<Project>(`${root}/projects/${r.projectId}`,{token:me.token})):null;
 return <Page title={r.title} parent={r.projectId?{href:`/work/projects/${r.projectId}`,label:project?.ok?project.value.name:'project'}:undefined}><Link href="/work/series">Recurring work</Link><section className="card"><p>{r.pausedAt?'Paused':r.nextDue?`Next due ${r.nextDue}`:'No next due date'} · {r.recurrence}</p>{r.projectId?<Link href={`/work/projects/${r.projectId}`}>{project?.ok?project.value.name:'Open project'}</Link>:<p>No project</p>}{r.body?<p className="work-record-body">{r.body}</p>:null}</section><nav className="row"><Link href={href}>Current and completed occurrences</Link><Link href={`${href}?status=cancelled`}>Cancelled occurrences</Link></nav><TaskList result={tasks} href={`${href}?status=${state}`} offset={start}/><section className="card"><details><summary>Edit recurring work</summary><RecordForm kind="series" id={r.id} revision={r.revision} key={r.revision}><SeriesFields series={r} members={members.ok?members.value.members:null} ownerId={me.me.user.id} project={project?.ok?project.value:null}/></RecordForm></details></section></Page>;
}
