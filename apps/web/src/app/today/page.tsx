import type { Metadata } from 'next';
import { RetiredFeature } from '../../components/RetiredFeature.tsx';

export const metadata: Metadata = { title: 'Today' };

/** Retired with the personal-assistant product (#133); no brief or question is read to render this. */
export default function RetiredPage() {
	return <RetiredFeature feature="today" returnTo="/today" />;
}
