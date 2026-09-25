import Link from 'next/link';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { api, load, type Project } from '../../../lib/api.ts';
import { offset } from '../records.ts';
import { WorkSwitch } from '../WorkSwitch.tsx';
import '../work.css';
export const metadata={title:'Projects'};
export default async function List({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const me=await requireCurrent('/work/projects');const s=await searchParams;const start=offset(s.offset);const filter=s.state==='archived'?'archived':'active';const q=new URLSearchParams({offset:String(start),limit:'50',state:filter});
 const result=await load(()=>api<{projects:Project[];nextOffset:number|null}>(`/v1/organisations/${me.organisation.organisationId}/projects?${q}`,{token:me.token}));
 const link=(n:number)=>{const p=new URLSearchParams(q);p.set('offset',String(n));return `/work/projects?${p}`;};
 return <Page title="Projects"><WorkSwitch selected="projects"/><nav className="row"><Link href="/work/projects">Active</Link><Link href="/work/projects?state=archived">Archived</Link></nav>{!result.ok?<Notice tone="failed" action={{href:link(start),label:'Try again'}}>{result.error.message}</Notice>:<section className="card"><ul className="bare work-list">{result.value.projects.map(r=><li className="work-task" key={r.id}><Link className="work-task__link" href={`/work/projects/${r.id}`}><span className="work-task__title">{r.name}</span><span className="work-task__meta">{r.state}</span></Link></li>)}</ul>{!result.value.projects.length?<p>No projects on this page.</p>:null}<nav className="row">{start>0?<Link href={link(Math.max(0,start-50))}>Previous</Link>:null}{result.value.nextOffset!==null?<Link href={link(result.value.nextOffset)}>Next</Link>:null}</nav></section>}<Link className="work-plus" href="/work/projects/new" aria-label="New project">+</Link></Page>;
}
