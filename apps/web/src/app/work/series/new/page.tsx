import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { api, load, type Member, type Project } from '../../../../lib/api.ts';
import { RecordForm } from '../../RecordForm.tsx';
import { SeriesFields } from '../../Fields.tsx';
export const metadata={title:'New recurring work'};
export default async function NewSeries({searchParams}:{searchParams:Promise<{projectId?:string}>}){const me=await requireCurrent('/work/series/new');const root=`/v1/organisations/${me.organisation.organisationId}`;const s=await searchParams;const [members,project]=await Promise.all([load(()=>api<{members:Member[]}>(`${root}/members`,{token:me.token})),s.projectId?load(()=>api<Project>(`${root}/projects/${encodeURIComponent(s.projectId!)}`,{token:me.token})):null]);return <Page title="New recurring work"><section className="card"><RecordForm kind="series" label="Create recurring work"><SeriesFields members={members.ok?members.value.members:null} ownerId={me.me.user.id} project={project?.ok&&project.value.state==='active'?project.value:null}/></RecordForm></section></Page>;}
