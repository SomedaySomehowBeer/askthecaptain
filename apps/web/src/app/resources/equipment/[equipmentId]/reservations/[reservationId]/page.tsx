import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '../../../../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../../../../components/Page.tsx';
import { api, load } from '../../../../../../lib/api.ts';
import { reservationLookups } from '../../../new/lookups.ts';
import { ReservationForm } from '../../../ReservationForm.tsx';
import { displayTime, localValue } from '../../../time.ts';
import { uuid, type Equipment, type Reservation } from '../../../types.ts';
import { CancelReservation } from './CancelReservation.tsx';
import '../../../forms.css';

export const metadata: Metadata = { title: 'Reservation' };

const minutes = (n: number) => n === 0 ? 'none' : n % 60 === 0 ? `${n / 60} h` : n > 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`;

/** One reservation as the API holds it: actual and occupied time in the organisation's zone with
 *  offsets, its links, and edit/cancel against this revision. No generic plus on a single record. */
export default async function ReservationPage({ params }: { params: Promise<{ equipmentId: string; reservationId: string }> }) {
	const raw = await params;
	const equipmentId = raw.equipmentId.toLowerCase(); const reservationId = raw.reservationId.toLowerCase();
	const valid = uuid.test(equipmentId) && uuid.test(reservationId);
	const path = `/resources/equipment/${equipmentId}/reservations/${reservationId}`;
	const me = await requireCurrent(valid ? path : '/resources/equipment');
	if (!valid) return <Page title="Reservation"><Notice title="This link is not valid" action={{ href: '/resources/equipment', label: 'Open the schedule' }}>The address does not name a reservation.</Notice></Page>;
	const org = me.organisation.organisationId;
	const [reservation, equipment, lookups] = await Promise.all([
		load(() => api<Reservation>(`/v1/organisations/${org}/equipment/${equipmentId}/reservations/${reservationId}`, { token: me.token })),
		load(() => api<Equipment>(`/v1/organisations/${org}/equipment/${equipmentId}`, { token: me.token })),
		reservationLookups(me.token, org)
	]);
	if (!reservation.ok) {
		return <Page title="Reservation">{reservation.error.status === 404
			? <Notice title="This reservation is not available" action={{ href: '/resources/equipment', label: 'Open the schedule' }}>It may belong to other equipment or another organisation, or the link is wrong.</Notice>
			: <Notice title="The reservation could not be read" tone="failed" action={{ href: path, label: 'Try again' }}>{reservation.error.message}{reservation.error.requestId ? ` Reference: ${reservation.error.requestId}` : ''}</Notice>}</Page>;
	}
	if (!lookups.timeZone) {
		return <Page title="Reservation"><Notice title="The organisation’s timezone could not be read" tone="failed" action={{ href: path, label: 'Try again' }}>
			Times cannot be shown safely without it. {lookups.timeZoneError?.message}</Notice></Page>;
	}
	const r = reservation.value; const zone = lookups.timeZone;
	const name = equipment.ok ? equipment.value.name : 'This equipment';
	const archived = equipment.ok && !!equipment.value.archivedAt;
	const person = (id: string | null) => id ? lookups.labels[id] ?? 'A person no longer listed' : 'No one';
	const date = localValue(r.startsAt, zone).slice(0, 10);
	return (
		<Page title={r.title} lede={`${r.kind === 'maintenance' ? 'Maintenance' : 'Booking'} · ${name}`}>
			<section className="card reservation-detail" aria-label="Reservation">
				<div className="row">
					<span className={`chip${r.status === 'confirmed' ? ' chip--project' : ''}`}>{r.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}</span>
					<span className="muted">Revision {r.revision}</span>
				</div>
				<dl className="reservation-detail__facts">
					<dt>Starts</dt><dd>{displayTime(r.startsAt, zone)}</dd>
					<dt>Ends</dt><dd>{displayTime(r.endsAt, zone)}</dd>
					<dt>Setup / cleanup</dt><dd>{minutes(r.setupMinutes)} before · {minutes(r.cleanupMinutes)} after</dd>
					<dt>Equipment occupied</dt><dd>{displayTime(r.occupiedStartsAt, zone)} to {displayTime(r.occupiedEndsAt, zone)}</dd>
					<dt>Timezone</dt><dd>{zone}</dd>
					<dt>Accountable</dt><dd>{person(r.ownerId)}</dd>
					<dt>Project</dt><dd>{r.projectId ? <Link href={`/commitments#project-${r.projectId}`}>{lookups.labels[r.projectId] ?? 'Open the project'}</Link> : 'None'}</dd>
					<dt>Task</dt><dd>{r.taskId ? <Link href={`/commitments#task-${r.taskId}`}>{lookups.labels[r.taskId] ?? 'Open the task'}</Link> : 'None'}</dd>
					<dt>Created by</dt><dd>{person(r.createdBy)}</dd>
				</dl>
				{!equipment.ok ? <p className="muted">The equipment details could not be read ({equipment.error.message}); the reservation above is current.</p> : null}
			</section>
			{r.status === 'cancelled' ? (
				<Notice title="This reservation is cancelled" action={archived ? undefined : { href: `/resources/equipment/new?equipmentId=${equipmentId}&date=${date}`, label: 'Reserve again' }}>
					This reservation no longer holds the equipment; other bookings may occupy that time. A cancelled reservation cannot be restored; make a new one to book again.{archived ? ` ${name} is archived, so restore it first.` : ''}
				</Notice>
			) : (
				<>
					<section className="card">
						<h2>Change</h2>
						{archived ? <p className="muted">{name} is archived, so this reservation can be cancelled but not changed. Restore the equipment to edit it.</p> : (<>
							{lookups.problems.length ? <p className="muted">Some choices could not be read ({lookups.problems.join(' ')}). Links you do not change are kept.</p> : null}
							<p className="muted">Saving sends every field again and rechecks every link: clear a project, task or person that is no longer available.</p>
							<ReservationForm key={`${r.id}:${r.revision}`} mode="edit" reservation={r} equipment={{ id: equipmentId, name }} timeZone={zone} options={lookups.options} labels={lookups.labels} />
						</>)}
					</section>
					<section className="card"><h2>Cancel</h2><CancelReservation key={`${r.id}:${r.revision}`} equipmentId={equipmentId} reservationId={reservationId} revision={r.revision} title={r.title} /></section>
				</>
			)}
			<div className="row"><Link className="button button--ghost" href="/resources/equipment">Back to the schedule</Link></div>
		</Page>
	);
}
