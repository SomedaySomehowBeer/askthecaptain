import { requireCurrent, Page } from '../../components/Page.tsx';
import { LegacyWorkLink } from './LegacyWorkLink.tsx';
export default async function Legacy(){await requireCurrent('/work');return <Page title="Work"><LegacyWorkLink/><a href="/work">Open Work</a></Page>;}
