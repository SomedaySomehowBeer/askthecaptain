import { requireCurrent } from '../../components/Page.tsx';
/** Authenticate before any suspense boundary can stream a response. */
export default async function CalendarLayout({ children }: { children: React.ReactNode }) {
 await requireCurrent('/calendar'); return children;
}
