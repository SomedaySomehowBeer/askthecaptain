import { requireCurrent } from '../../components/Page.tsx';

/** The session check lives in the layout so a signed-out request is answered with a real 307
 *  before anything streams; the page's loading state only ever covers the list itself. */
export default async function CommitmentsLayout({ children }: { children: React.ReactNode }) {
	await requireCurrent('/commitments');
	return children;
}
