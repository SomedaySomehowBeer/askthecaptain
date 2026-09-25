import Link from 'next/link';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { api, load, type Series } from '../../../lib/api.ts';
import { offset } from '../records.ts';
import '../work.css';
export const metadata={title:'Recurring work'};
export default async function List({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const me=await requireCurrent('/work/series');const s=await searchParams;const start=offset(s.offset);const filter=s.paused==='true'?'true':'false';const q=new URLSearchParams({offset:String(start),limit:'50',paused:filter});
 if(typeof s.projectId==='string'&&/^[0-9a-f-]{36}$/i.test(s.projectId))q.set('projectId',s.projectId);
 const result=await load(()=>api<{series:Series[];nextOffset:number|null}>(`/v1/organisations/${me.organisation.organisationId}/series?${q}`,{token:me.token}));
 const link=(n:number)=>{const p=new URLSearchParams(q);p.set('offset',String(n));return `/work/series?${p}`;};
 return <Page title="Recurring work"><Link href="/work/views">Work views</Link><nav className="row"><Link href={typeof s.projectId==='string'?`/work/series?projectId=${encodeURIComponent(s.projectId)}`:'/work/series'}>Running</Link><Link href={typeof s.projectId==='string'?`/work/series?paused=true&projectId=${encodeURIComponent(s.projectId)}`:'/work/series?paused=true'}>Paused</Link></nav>{!result.ok?<Notice tone="failed" action={{href:link(start),label:'Try again'}}>{result.error.message}</Notice>:<section className="card"><ul className="bare work-list">{result.value.series.map(r=><li className="work-task" key={r.id}><Link className="work-task__link" href={`/work/series/${r.id}`}><span className="work-task__title">{r.title}</span><span className="work-task__meta">{r.pausedAt?'Paused':r.nextDue?`Next due ${r.nextDue}`:'No next due date'}</span></Link></li>)}</ul>{!result.value.series.length?<p>No recurring work on this page.</p>:null}<nav className="row">{start>0?<Link href={link(Math.max(0,start-50))}>Previous</Link>:null}{result.value.nextOffset!==null?<Link href={link(result.value.nextOffset)}>Next</Link>:null}</nav></section>}<Link className="work-plus" href="/work/series/new" aria-label="New recurring work">+</Link></Page>;
}
