'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { cancelReservation } from '../../../actions.ts';

/** Cancel against the revision on this page. Frees the time only once the API confirms it; an
 *  unconfirmed or stale result locks the button and asks for a reload of this page. */
export function CancelReservation({ equipmentId, reservationId, revision, title }: { equipmentId: string; reservationId: string; revision: number; title: string }) {
	const router = useRouter();
	const [pending, start] = useTransition();
	const [confirming, setConfirming] = useState(false);
	const [said, setSaid] = useState<{ locked: boolean; text: string } | null>(null);
	function cancel() {
		if (pending || said?.locked) return;
		const data = new FormData();
		data.set('equipmentId', equipmentId); data.set('reservationId', reservationId); data.set('expectedRevision', String(revision));
		setSaid(null);
		start(async () => {
			try {
				const result = await cancelReservation(data);
				if (result.ok) { router.refresh(); return; }
				setSaid({ locked: result.kind === 'uncertain' || result.kind === 'stale',
					text: result.kind === 'uncertain' ? 'Captain could not confirm the cancellation. Reload this page to see whether it was cancelled.' : result.error });
			} catch { setSaid({ locked: true, text: 'Captain could not confirm the cancellation. Reload this page to see whether it was cancelled.' }); }
		});
	}
	return (
		<div className="stack">
			{confirming ? (
				<div className="row">
					<button type="button" className="button button--danger" onClick={cancel} disabled={pending || said?.locked}>{pending ? 'Cancelling…' : `Cancel “${title}”`}</button>
					<button type="button" className="button button--ghost" onClick={() => setConfirming(false)} disabled={pending}>Keep it</button>
				</div>
			) : <button type="button" className="button button--secondary" onClick={() => setConfirming(true)}>Cancel this reservation</button>}
			<p className="muted">Cancelling frees the time for others straight away. It cannot be undone; book again to reserve the time.</p>
			{said ? <p className="form__error" role="alert">{said.text}{said.locked ? <> <a href={`/resources/equipment/${equipmentId}/reservations/${reservationId}`}>Reload</a></> : null}</p> : null}
		</div>
	);
}
