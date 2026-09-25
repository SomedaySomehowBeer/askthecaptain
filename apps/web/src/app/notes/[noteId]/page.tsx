import type { Metadata } from 'next';
import { RetiredFeature } from '../../../components/RetiredFeature.tsx';

export const metadata: Metadata = { title: 'Notes' };

/** Retired with the personal-assistant product (#133); no note is read to render this. */
export default function RetiredPage() {
	return <RetiredFeature feature="notes" returnTo="/notes" />;
}
