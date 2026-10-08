/** New booking (bookings contract §3), opened from the schedule's "New booking" with the equipment and day in view, or
 *  with nothing prefilled. Design board 2's booking fields (title, equipment, date, start, end, setup, cleanup) and the
 *  occupancy note that checks the slot as the person types; "Make the booking" sends one `POST …/reservations` with a
 *  client booking id and change set id, retry-safe like the card writes (an uncertain answer keeps both and the exact
 *  body for "Make again with the same ID"; nothing is retried by itself). An overlap names what holds the slot and keeps
 *  the form. Success opens the new booking's thread, found in the Bookings list. */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useAccount } from '../../account/AccountProvider.tsx';
import type { ReadScope } from '../../account/contracts.ts';
import { isSignedIn, webCopy } from '../../account/copy.ts';
import { PlainText, Screen } from '../../components/Screen.tsx';
import { copy } from '../../threads/copy.ts';
import type { ThreadCalls } from '../../threads/api.ts';
import { BookingFields, useOccupancy } from '../../threads/cards/BookingFields.tsx';
import { CardButton, Muted, Note, TextField, type Option } from '../../threads/cards/Fields.tsx';
import { cardCopy } from '../../threads/cards/copy.ts';
import { refusedForGood, type BookingForm } from '../../threads/cards/forms.ts';
import { send, type Booking } from '../../threads/cards/records.ts';
import { useBookingSetup } from '../../threads/cards/useBookingSetup.ts';
import { useSaver, type CardHooks } from '../../threads/cards/useSaver.ts';
import { useDeadline } from '../../threads/use-poll.ts';
import { bookingThread, newBookingForm, newBookingPlan, newBookingWrite, prefillWords, readPrefill } from '../../resources/equipment/new-booking.ts';
import { todayInZone } from '../../resources/equipment/zone.ts';
import { themedStyles } from '../../theme/theme.ts';
import { type } from '../../theme/tokens.ts';
import Welcome from '../welcome.tsx';

const newBookingCopy = {
	heading: 'New booking',
	help: 'Books shared equipment. The booking gets its own thread for messages and changes.',
	make: 'Make the booking',
	lost: 'This organisation’s equipment is no longer available to you. Nothing was made.',
	notFound: 'The booking is made. Its thread isn’t in the latest bookings yet; find it under Bookings in Threads.',
	openThreads: 'Open Threads'
} as const;

export default function NewBookingPage() {
	const account = useAccount(), view = account.snapshot.account;
	const params = useLocalSearchParams<{ equipment?: string; day?: string }>();
	const back = { label: 'Equipment schedule', onPress: () => { if (router.canGoBack()) router.back(); else router.replace('/equipment'); } };
	if (view.kind === 'checking' || view.kind === 'starting') return <Screen back={back} title={newBookingCopy.heading}><PlainText>{webCopy.checking}</PlainText></Screen>;
	if (view.kind === 'unverified') return <Welcome />;
	if (!isSignedIn(view)) return null;
	if (!account.web || !view.scope || view.org.kind !== 'chosen') return <Screen back={back} title={newBookingCopy.heading}><PlainText>{copy.unavailable}</PlainText></Screen>;
	return <Screen back={back} title={newBookingCopy.heading}>
		<NewBooking key={view.scope.epoch} calls={account.web.threads} scope={view.scope} now={account.now} params={{ equipment: params.equipment, day: params.day }} />
	</Screen>;
}

function NewBooking({ calls, scope, now, params }: { calls: ThreadCalls; scope: ReadScope; now: () => number; params: { equipment?: string | string[]; day?: string | string[] } }) {
	const styles = useStyles();
	const year = new Date().getFullYear();
	const [lost, setLost] = useState(false);
	const [opening, setOpening] = useState<'looking' | 'not-found' | null>(null);
	const setup = useBookingSetup(calls, scope, () => setLost(true));
	// The booking's own id belongs to its change set id, so a retry (or a 429 that kept the change set id) sends both again.
	const bookingIds = useRef(new Map<string, string>());
	const bookingId = (changeSetId: string) => { let id = bookingIds.current.get(changeSetId); if (!id) { id = Crypto.randomUUID(); bookingIds.current.set(changeSetId, id); } return id; };
	const [hooks] = useState<CardHooks>(() => ({ now, saved: () => {}, reload: () => {}, lost: () => setLost(true) }));
	const [saver, state] = useSaver<Booking & { changeSetId: string }>(hooks, cardCopy.newBooking, (made) => { if (made) void open(made.id); });
	const [form, setForm] = useState<BookingForm | null>(null);
	const [equipmentId, setEquipmentId] = useState<string | null>(null);
	const [notes, setNotes] = useState<string[]>([]);
	const [multiDay, setMultiDay] = useState(false);
	useEffect(() => {
		if (setup.kind !== 'ready' || form) return;
		const prefill = readPrefill(params, setup.equipment, todayInZone(setup.zone));
		setForm(newBookingForm(prefill.date)); setEquipmentId(prefill.equipmentId); setNotes(prefill.notes.map((n) => prefillWords[n]));
	}, [setup.kind]);
	async function open(id: string) {
		setOpening('looking');
		const list = await calls.list(scope, 'bookings');
		const thread = list.kind === 'ok' ? bookingThread(list.value, id) : null;
		if (list.kind === 'stale') return;
		if (thread) router.replace(`/threads/${thread}`); else setOpening('not-found');
	}
	const zone = setup.kind === 'ready' ? setup.zone : null;
	const options = useMemo<Option[]>(() => setup.kind === 'ready' ? setup.equipment.map((e) => ({ value: e.id, label: e.name })) : [], [setup]);
	const plan = form && zone ? newBookingPlan(form, zone, multiDay) : null;
	const free = useOccupancy(calls, scope, equipmentId, plan, zone, year, state.refusal);
	const busy = state.busy, uncertain = state.uncertain, waiting = useDeadline(state.waitUntil, now);
	const done = opening !== null;
	const editable = !busy && !uncertain && !done;
	const ready = Boolean(plan && 'time' in plan && equipmentId) && free.kind !== 'taken';
	const set = (next: Partial<BookingForm>) => { if (!form) return; setForm({ ...form, ...next }); if (!busy && !uncertain) saver.clear(); };
	const save = () => {
		if (!ready || !plan || !('time' in plan) || !equipmentId) return;
		const time = plan.time, equipment = equipmentId;
		void saver.save((changeSetId) => { const w = newBookingWrite(scope, equipment, bookingId(changeSetId), changeSetId, time); return { body: w.body, send: () => send(calls, scope, w) }; });
	};
	if (lost) return <Note tone="warn" testID="new-booking-lost">{newBookingCopy.lost}</Note>;
	return <View style={styles.stack} testID="new-booking">
		<Muted>{newBookingCopy.help}</Muted>
		{setup.kind === 'loading' ? <Text testID="new-booking-loading" style={styles.body}>{cardCopy.loading}</Text> : null}
		{setup.kind === 'failed' ? <View style={styles.stack}><Note tone="warn" testID="new-booking-setup-failed">{setup.message}</Note>
			<CardButton testID="new-booking-setup-retry" label="Try again" onPress={setup.retry} /></View> : null}
		{setup.kind === 'ready' && setup.equipment.length === 0 ? <View style={styles.stack}><Note tone="neutral" testID="new-booking-no-equipment">{cardCopy.noEquipment}</Note>
			<CardButton testID="new-booking-manage" label="Manage equipment" onPress={() => router.push('/equipment/manage')} /></View> : null}
		{setup.kind === 'ready' && zone && form && setup.equipment.length ? <View style={styles.card}>
			{notes.map((n) => <Note key={n} tone="neutral" testID="new-booking-prefill-note">{n}</Note>)}
			<TextField label="Title" testID="new-booking-title" value={form.title} onChange={(title) => set({ title })} disabled={!editable} maxLength={200} placeholder="What the equipment is booked for" />
			<BookingFields prefix="new-booking" form={form} set={set} multiDay={multiDay} setMultiDay={setMultiDay} equipment={options} equipmentId={equipmentId}
				setEquipment={(id) => { setEquipmentId(id); if (!busy && !uncertain) saver.clear(); }} disabled={!editable} plan={plan} free={free} zone={zone} year={year} />
			{setup.more ? <Muted>{cardCopy.moreEquipment}</Muted> : null}
			<View style={styles.row}>
				{uncertain
					? <><CardButton testID="new-booking-retry" label="Make the booking again with the same ID" display="Make again with the same ID" primary grow disabled={busy || waiting} onPress={() => { void saver.retry(); }} />
						<CardButton testID="new-booking-discard" label="Discard this booking" display="Discard" disabled={busy} onPress={() => saver.discard()} /></>
					: <><CardButton testID="new-booking-save" label={newBookingCopy.make} primary grow disabled={!editable || waiting || !ready || refusedForGood(state.refusal)} onPress={save} />
						<CardButton testID="new-booking-cancel" label="Cancel" disabled={busy || done} onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/equipment'); }} /></>}
			</View>
			{state.message ? <Text testID="new-booking-status" role="status" style={state.tone === 'warn' ? styles.warn : styles.ok}>{state.message}</Text>
				: <Muted testID="new-booking-help">{cardCopy.bookingTogether}</Muted>}
			{opening === 'not-found' ? <View style={styles.stack}><Note tone="neutral" testID="new-booking-not-found">{newBookingCopy.notFound}</Note>
				<CardButton testID="new-booking-open-threads" label={newBookingCopy.openThreads} onPress={() => router.replace('/')} /></View> : null}
		</View> : null}
	</View>;
}

/** Design board 2's card (R3 captain.css `.card`) around the fields, on the schedule's page. */
const useStyles = themedStyles((colors) => ({
	stack: { gap: 12 },
	card: { gap: 10, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	body: { fontSize: type.body, lineHeight: type.bodyLine, color: colors.body },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
