import { requireCurrent } from '../../components/Page.tsx';
export default async function ResourcesLayout({ children }: { children: React.ReactNode }) { await requireCurrent('/resources'); return children; }
