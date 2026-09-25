import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { RecordForm } from '../../RecordForm.tsx';
import { ProjectFields } from '../../Fields.tsx';
export const metadata={title:'New project'};
export default async function NewProject(){await requireCurrent('/work/projects/new');return <Page title="New project"><section className="card"><RecordForm kind="projects" label="Create project"><ProjectFields/></RecordForm></section></Page>;}
