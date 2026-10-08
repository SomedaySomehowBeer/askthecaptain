import { useEffect, useState } from 'react';
import type { ReadScope } from '../../account/contracts.ts';
import { equipmentPagePath } from '../../api/paths.ts';
import { equipmentPageParser, type Equipment } from '../../resources/equipment/data.ts';
import type { ThreadCalls } from '../api.ts';
import { reads } from './records.ts';

/** What a new booking's fields need before they can be filled: the organisation's time zone and the active equipment
 *  (the first page of 100, as the schedule reads it). Read once per mount; Try again reads again. Archived equipment is
 *  never offered. */
export type BookingSetup =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string; readonly retry: () => void }
	| { readonly kind: 'ready'; readonly zone: string; readonly equipment: readonly Equipment[]; readonly more: boolean };
export const setupCopy = {
	failed: 'Couldn’t load the equipment and the business time zone. Try again.',
	wait: 'Captain asked you to wait before loading this again. Try again in a moment.'
} as const;

export function useBookingSetup(calls: ThreadCalls, scope: ReadScope, lost: () => void): BookingSetup {
	const [n, setN] = useState(0);
	const [state, setState] = useState<BookingSetup>({ kind: 'loading' });
	useEffect(() => {
		let live = true;
		setState({ kind: 'loading' });
		const retry = () => setN((v) => v + 1);
		void (async () => {
			const zone = await reads.zone(calls, scope);
			if (!live || zone.kind === 'stale') return;
			if (zone.kind === 'error') { if (zone.status === 404) lost(); else setState({ kind: 'failed', message: zone.status === 429 ? setupCopy.wait : setupCopy.failed, retry }); return; }
			const page = await calls.request(scope, 'GET', equipmentPagePath(scope, 0), undefined, equipmentPageParser({ offset: 0, limit: 100 }));
			if (!live || page.kind === 'stale') return;
			if (page.kind === 'error') { if (page.status === 404) lost(); else setState({ kind: 'failed', message: page.status === 429 ? setupCopy.wait : setupCopy.failed, retry }); return; }
			setState({ kind: 'ready', zone: zone.value, equipment: page.value.equipment, more: page.value.nextOffset !== null });
		})();
		return () => { live = false; };
	}, [n]);
	return state;
}
