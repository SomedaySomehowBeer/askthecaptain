import Link from 'next/link';
import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { Notice } from '../../../../components/Notice.tsx';
import { api, load, type Project } from '../../../../lib/api.ts';
import { RecordForm } from '../../RecordForm.tsx';
import { ProjectFields } from '../../Fields.tsx';
import { TaskList } from '../../RecordLists.tsx';
import type { WorkPage } from '../../types.ts';
import { offset } from '../../records.ts';
import '../../work.css';
export default async function ProjectPage({params,searchParams}:{params:Promise<{projectId:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const {projectId}=await params;const href=`/work/projects/${projectId}`;const me=await requireCurrent(href);const s=await searchParams;const start=offset(s.offset);const state=s.status==='cancelled'?'cancelled':'all';const root=`/v1/organisations/${me.organisation.organisationId}`;
 const [result,tasks]=await Promise.all([load(()=>api<Project>(`${root}/projects/${projectId}`,{token:me.token})),load(()=>api<WorkPage>(`${root}/tasks?projectId=${projectId}${state==='cancelled'?'&status=cancelled':''}&offset=${start}&limit=50`,{token:me.token}))]);
 if(!result.ok)return <Page title="Project"><Notice tone="failed">{result.error.message}</Notice><Link href="/work/projects">Projects</Link></Page>;
 const p=result.value;return <Page title={p.name} parent={{href:`/work/projects${p.state==='archived'?'?state=archived':''}`,label:'Projects'}}><nav className="row"><Link href="/work/projects">Projects</Link><span>{p.state} · {p.stage}</span></nav>{p.description?<p className="work-record-body">{p.description}</p>:null}<nav className="row"><Link href={href}>Current and completed tasks</Link><Link href={`${href}?status=cancelled`}>Cancelled tasks</Link><Link href={`/work/new?projectId=${p.id}`}>New task</Link><Link href={`/work/series?projectId=${p.id}`}>Recurring work in this project</Link><Link href={`/work/series/new?projectId=${p.id}`}>New recurring work</Link></nav><TaskList result={tasks} href={`${href}?status=${state}`} offset={start}/><section className="card"><details><summary>Edit project</summary><RecordForm kind="projects" id={p.id} revision={p.revision} key={p.revision}><ProjectFields project={p}/></RecordForm></details></section>{p.state==='active'?<Link className="work-plus" href={`/work/new?projectId=${p.id}`} aria-label="New task in this project">+</Link>:null}</Page>;
}
