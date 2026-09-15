import { requireCurrent } from '../../../components/Page.tsx';
export default async function ContactLayout({ children }: { children: React.ReactNode }) {
 await requireCurrent('/inbox'); return children;
}
