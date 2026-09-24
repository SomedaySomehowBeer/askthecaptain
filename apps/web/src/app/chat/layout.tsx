import { requireCurrent } from '../../components/Page.tsx';
export default async function ChatLayout({ children }: { children: React.ReactNode }) { await requireCurrent('/chat'); return children; }
