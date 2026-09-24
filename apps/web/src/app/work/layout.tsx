import { requireCurrent } from '../../components/Page.tsx';

/** The session check lives in the layout so a signed-out request is answered with a real redirect
 *  before anything streams; the loading state only ever covers the list itself. */
export default async function WorkLayout({ children }: { children: React.ReactNode }) {
	await requireCurrent('/work');
	return children;
}
