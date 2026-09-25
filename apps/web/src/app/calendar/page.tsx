import type { Metadata } from 'next';
import { RetiredFeature } from '../../components/RetiredFeature.tsx';

export const metadata: Metadata = { title: 'Calendar' };

/** Retired with the personal-assistant product (#133); no calendar event is read to render this. */
export default function RetiredPage() {
	return <RetiredFeature feature="calendar" returnTo="/calendar" />;
}
