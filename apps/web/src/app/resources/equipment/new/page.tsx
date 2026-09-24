import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import { Notice } from '../../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { api, load } from '../../../../lib/api.ts';
import { ReservationForm } from '../ReservationForm.tsx';
import { shiftDate, todayInZone } from '../time.ts';
import { uuid, type Equipment } from '../types.ts';
import { reservationLookups } from './lookups.ts';
import '../forms.css';

export const metadata: Metadata = { title: 'Reserve equipment' };

/** Reserve one piece of equipment, opened from the schedule with the equipment and day selected.
 *  Times are local to the organisation; the saved record page confirms what was booked. */
export default async function NewReservationPage({ searchParams }: { searchParams: Promise<{ equipmentId?: string | string[]; date?: string | string[] }> }) {
	const me = await requireCurrent('/resources/equipment');
	const query = await searchParams;
	const equipmentId = typeof query.equipmentId === 'string' ? query.equipmentId.toLowerCase() : '';
	if (!uuid.test(equipmentId)) {
		return <Page title="Reserve equipment"><Notice title="Choose equipment first" action={{ href: '/resources/equipment', label: 'Open the schedule' }}>
			Pick the equipment and day on the schedule, then reserve from there. Equipment is added under Manage equipment.</Notice></Page>;
	}
	const org = me.organisation.organisationId;
	const [equipment, lookups] = await Promise.all([load(() => api<Equipment>(`/v1/organisations/${org}/equipment/${equipmentId}`, { token: me.token })), reservationLookups(me.token, org)]);
	if (!equipment.ok) {
		return <Page title="Reserve equipment">{equipment.error.status === 404
			? <Notice title="That equipment is not available" action={{ href: '/resources/equipment', label: 'Open the schedule' }}>It may have been removed from this organisation, or the link is wrong.</Notice>
			: <Notice title="The equipment could not be read" tone="failed" action={{ href: `/resources/equipment/new?equipmentId=${equipmentId}`, label: 'Try again' }}>{equipment.error.message}</Notice>}</Page>;
	}
	if (equipment.value.archivedAt) {
		return <Page title="Reserve equipment"><Notice title={`${equipment.value.name} is archived`} action={{ href: '/resources/equipment/manage?archived=true', label: 'Manage equipment' }}>
			Restore it before making a reservation.</Notice></Page>;
	}
	if (!lookups.timeZone) {
		return <Page title="Reserve equipment"><Notice title="The organisation’s timezone could not be read" tone="failed" action={{ href: `/resources/equipment/new?equipmentId=${equipmentId}`, label: 'Try again' }}>
			Times cannot be shown or saved safely without it. {lookups.timeZoneError?.message}</Notice></Page>;
	}
	const today = todayInZone(lookups.timeZone);
	const valid = (value: unknown): value is string => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; try { return shiftDate(value, 0) === value; } catch { return false; } };
	const date = valid(query.date) ? query.date : today;
	return (
		<Page title="Reserve equipment" lede="Choose the time, including setup and cleanup. Saving checks every other reservation at that moment; nothing is booked until it is saved.">
			{lookups.problems.length ? <Notice tone="attention">Some choices could not be read ({lookups.problems.join(' ')}). Links you do not change are left as they are.</Notice> : null}
			<section className="card">
				<ReservationForm mode="create" requestId={randomUUID()} equipment={{ id: equipment.value.id, name: equipment.value.name }} timeZone={lookups.timeZone}
					options={lookups.options} labels={lookups.labels}
					values={{ title: '', kind: 'booking', startsLocal: `${date}T09:00`, endsLocal: `${date}T10:00`, setupMinutes: 0, cleanupMinutes: 0, projectId: null, taskId: null, ownerId: me.me.user.id }} />
			</section>
		</Page>
	);
}
