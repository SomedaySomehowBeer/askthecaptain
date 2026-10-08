/** Design board 3's pattern (Topic.dc.html) for "Make this a booking" on a topic's unfolded card (bookings contract §3):
 *  the heading, one sentence, board 2's booking fields with the occupancy note, "Make this a booking" and Cancel. One
 *  request (`POST …/threads/:id/booking`) with the thread's revision and a client change set id, with the card writes'
 *  uncertain-write rules: an uncertain answer locks the form until "Make it again" (the same id and body) or "Discard";
 *  never retried by itself. An overlap names what holds the slot, read from the equipment's schedule, and keeps the
 *  form. On success the same thread reloads as the booking's thread. Not offered on a private thread or a record's. */
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { ReadScope } from '../../account/contracts.ts';
import { themedStyles } from '../../theme/theme.ts';
import { threadPath, type ThreadCalls } from '../api.ts';
import type { Detail } from '../contracts.ts';
import { newBookingForm, newBookingPlan } from '../../resources/equipment/new-booking.ts';
import { todayInZone } from '../../resources/equipment/zone.ts';
import { makeBookingBody, parseMadeBooking } from './make-booking.ts';
import { BookingFields, useOccupancy } from './BookingFields.tsx';
import { CardButton, Muted, Note, type Option } from './Fields.tsx';
import { cardCopy } from './copy.ts';
import { useSaver, type CardHooks } from './useSaver.ts';
import { refusedForGood, type BookingForm } from './forms.ts';
import { useBookingSetup } from './useBookingSetup.ts';
import { useDeadline } from '../use-poll.ts';

export function MakeBooking({ calls, scope, detail, hooks, locked, confirmed, onCancel }: {
	calls: ThreadCalls; scope: ReadScope; detail: Detail; hooks: CardHooks; locked: boolean; confirmed: readonly string[]; onCancel: () => void;
}) {
	const styles = useStyles();
	const year = new Date().getFullYear();
	const setup = useBookingSetup(calls, scope, hooks.lost);
	const [saver, state] = useSaver<Detail>(hooks, cardCopy.makeBooking);
	const [form, setForm] = useState<BookingForm | null>(null);
	const [equipmentId, setEquipmentId] = useState<string | null>(null);
	const [multiDay, setMultiDay] = useState(false);
	useEffect(() => { saver.confirm(confirmed); }, [confirmed]);
	// Refused because the thread is already a record's: show it as it is now.
	useEffect(() => { if (state.refusal === 'thread_is_record') hooks.reload(); }, [state.refusal]);
	useEffect(() => {
		if (setup.kind !== 'ready' || form) return;
		setForm(newBookingForm(todayInZone(setup.zone))); setEquipmentId(setup.equipment[0]?.id ?? null);
	}, [setup.kind]);
	const zone = setup.kind === 'ready' ? setup.zone : null;
	const options = useMemo<Option[]>(() => setup.kind === 'ready' ? setup.equipment.map((e) => ({ value: e.id, label: e.name })) : [], [setup]);
	const plan = form && zone ? newBookingPlan({ ...form, title: detail.thread.title || detail.card.title }, zone, multiDay) : null;
	const free = useOccupancy(calls, scope, equipmentId, plan, zone, year, state.refusal);
	const busy = state.busy, uncertain = state.uncertain, waiting = useDeadline(state.waitUntil, hooks.now);
	const editable = !locked && !busy && !uncertain;
	const ready = Boolean(plan && 'time' in plan && equipmentId) && free.kind !== 'taken';
	const set = (next: Partial<BookingForm>) => { if (!form) return; setForm({ ...form, ...next }); if (!busy && !uncertain) saver.clear(); };
	const save = () => {
		if (!ready || !plan || !('time' in plan) || !equipmentId) return;
		const time = plan.time, equipment = equipmentId;
		void saver.save((id) => {
			const body = makeBookingBody(id, detail.thread.revision, equipment, time);
			return { body, send: () => calls.request(scope, 'POST', threadPath(scope, detail.thread.id, 'booking'), body, (v) => parseMadeBooking(v, detail.thread.id)) };
		});
	};
	return <View testID="make-booking" style={styles.box}>
		<Text role="heading" aria-level={2} style={styles.heading}>{cardCopy.makeBookingHeading}</Text>
		<Muted>{cardCopy.makeBookingHelp}</Muted>
		{setup.kind === 'loading' ? <Muted testID="make-booking-loading">{cardCopy.loading}</Muted> : null}
		{setup.kind === 'failed' ? <View style={styles.row}><Note tone="warn" testID="make-booking-setup-failed">{setup.message}</Note>
			<CardButton testID="make-booking-setup-retry" label="Try again" onPress={setup.retry} /></View> : null}
		{setup.kind === 'ready' && setup.equipment.length === 0 ? <Note tone="neutral" testID="make-booking-no-equipment">{cardCopy.noEquipment}</Note> : null}
		{setup.kind === 'ready' && zone && form && setup.equipment.length ? <>
			<BookingFields prefix="make-booking" form={form} set={set} multiDay={multiDay} setMultiDay={setMultiDay} equipment={options} equipmentId={equipmentId}
				setEquipment={(id) => { setEquipmentId(id); if (!busy && !uncertain) saver.clear(); }} disabled={!editable} plan={plan} free={free} zone={zone} year={year} />
			{setup.more ? <Muted>{cardCopy.moreEquipment}</Muted> : null}
		</> : null}
		<View style={styles.row}>
			{uncertain
				? <><CardButton testID="make-booking-retry" label="Make this a booking again with the same change ID" display="Make it again" primary grow disabled={busy || waiting} onPress={() => { void saver.retry(); }} />
					<CardButton testID="make-booking-discard" label="Discard making this a booking" display="Discard" disabled={busy} onPress={() => saver.discard()} /></>
				: <><CardButton testID="make-booking-save" label="Make this a booking" primary grow disabled={!editable || waiting || !ready || refusedForGood(state.refusal)} onPress={save} />
					<CardButton testID="make-booking-cancel" label="Cancel" disabled={busy} onPress={() => { saver.clear(); onCancel(); }} /></>}
		</View>
		{state.message ? <Text testID="make-booking-status" role="status" style={state.tone === 'warn' ? styles.warn : styles.ok}>{state.message}</Text> : null}
	</View>;
}

const useStyles = themedStyles((colors) => ({
	box: { gap: 10, borderTopWidth: 1, borderColor: colors.rowLine, paddingTop: 10 },
	heading: { fontSize: 15, fontWeight: '600', color: colors.heading },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
