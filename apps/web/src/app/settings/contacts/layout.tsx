import { requireCurrent } from '../../../components/Page.tsx';
export default async function ContactsLayout({ children }: { children: React.ReactNode }) {
 await requireCurrent('/settings/contacts'); return children;
}
