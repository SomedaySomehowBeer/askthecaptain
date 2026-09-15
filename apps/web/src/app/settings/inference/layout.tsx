import { requireCurrent } from '../../../components/Page.tsx';
export default async function InferenceLayout({ children }: { children: React.ReactNode }) {
 await requireCurrent('/settings/inference'); return children;
}
