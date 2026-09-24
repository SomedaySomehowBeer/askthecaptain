import { requireCurrent } from '../../components/Page.tsx';
export default async function TodayLayout({ children }: { children: React.ReactNode }) { await requireCurrent('/today'); return children; }
