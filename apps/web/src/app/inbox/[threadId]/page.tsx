import type { Metadata } from 'next';
import { RetiredFeature } from '../../../components/RetiredFeature.tsx';

export const metadata: Metadata = { title: 'Inbox' };

/** Retired with the personal-assistant product (#133); no mail thread is read to render this. */
export default function RetiredPage() {
	return <RetiredFeature feature="inbox" returnTo="/inbox" />;
}
