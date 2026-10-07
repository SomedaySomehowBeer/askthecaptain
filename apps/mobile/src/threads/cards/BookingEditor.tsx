/** Design board 2 (Booking.dc.html): the unfolded booking card. Title and time (date, start, end, setup, cleanup) are
 *  saved together as one change set; the note says what the booking will hold and whether that time is free; an overlap
 *  refusal names what holds the slot, read from the equipment's schedule; "Cancel this booking" asks first. */
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { ReadScope } from '../../account/contracts.ts';
import type { ThreadCalls } from '../api.ts';
import type { Detail } from '../contracts.ts';
import { themedStyles } from '../../theme/theme.ts';
import { CardButton, DateTimeField, Muted, Note, SelectField, TextField } from './Fields.tsx';
import { bookingChanged, bookingControls, bookingForm, bookingPlan, bookingStart, minuteChoices, occupancyWords, spansDays, type Availability, type BookingForm } from './forms.ts';
import { reads, send, writes, type Booking } from './records.ts';
import type { RecordState } from './store.ts';
import { useSaver, type CardHooks } from './useSaver.ts';
import { cardCopy } from './copy.ts';
import { useDeadline } from '../use-poll.ts';

export function BookingEditor({ calls, scope, detail, record, hooks, locked, confirmed, year }: {
	calls: ThreadCalls; scope: ReadScope; detail: Detail; record: RecordState; hooks: CardHooks; locked: boolean; confirmed: readonly string[]; year: number;
}) {
	const styles = useStyles();
	const booking = record.booking, zone = record.zone;
	const equipmentName = typeof detail.card.fold.equipmentName === 'string' ? detail.card.fold.equipmentName : 'equipment';
	const resync = useRef(false);
	const [own] = useState<CardHooks>(() => ({ ...hooks, reload: () => { resync.current = true; hooks.reload(); } }));
	const [saver, saveState] = useSaver<Booking>(own, cardCopy.booking, () => { resync.current = true; });
	const [canceller, cancelState] = useSaver<Booking>(own, cardCopy.cancel);
	// A record already loaded when the card unfolds opens as it is: a booking that spans days shows its end date.
	const [start] = useState(() => booking && zone ? bookingStart(booking, zone) : null);
	const [form, setForm] = useState<BookingForm | null>(start?.form ?? null);
	const [base, setBase] = useState<Booking | null>(booking);
	const [multiDay, setMultiDay] = useState(start?.multiDay ?? false);
	const [asking, setAsking] = useState(false);
	const [free, setFree] = useState<Availability>({ kind: 'idle' });
	const check = useRef(0);
	useEffect(() => {
		if (!booking || !zone) return;
		if (resync.current || !form || !base || base.revision !== booking.revision) {
			const plan = form && base ? bookingPlan(base, form, zone, multiDay) : null;
			const touched = plan && 'time' in plan ? bookingChanged(base!, plan.time) : Boolean(form && base);
			if (resync.current || !form || !base || !touched) { const f = bookingForm(booking, zone); setForm(f); setMultiDay(spansDays(f)); }
			resync.current = false; setBase(booking);
		}
	}, [booking, zone]);
	useEffect(() => { saver.confirm(confirmed); canceller.confirm(confirmed); }, [confirmed]);

	const plan = form && base && zone ? bookingPlan(base, form, zone, multiDay) : null;
	// Re-render when a server wait ends, so an action it held is offered again.
	const waiting = useDeadline(Math.max(saveState.waitUntil, cancelState.waitUntil), hooks.now);
	const slot = plan && 'time' in plan ? `${plan.occupiedFrom}|${plan.occupiedTo}` : null;
	// What the time would hold, checked against the equipment's schedule after the person stops typing.
	useEffect(() => {
		if (!slot || !base || !zone || base.status === 'cancelled') { setFree({ kind: 'idle' }); return; }
		const [from, to] = slot.split('|') as [string, string];
		const n = ++check.current; setFree({ kind: 'checking' });
		const timer = setTimeout(() => { void reads.occupancy(calls, scope, base, zone, from, to, year).then((found) => { if (found && n === check.current) setFree(found); }); }, 500);
		return () => clearTimeout(timer);
	}, [slot, base?.id, base?.revision, saveState.refusal]);

	if (!booking || !zone || !form || !base) {
		return <View style={styles.box}>{record.message ? <Note tone="warn" testID="card-record-status">{record.message}</Note> : <Muted testID="card-record-loading">{cardCopy.loading}</Muted>}</View>;
	}
	const cancelled = base.status === 'cancelled';
	const uncertain = saveState.uncertain || cancelState.uncertain, busy = saveState.busy || cancelState.busy;
	const changed = plan && 'time' in plan ? bookingChanged(base, plan.time) : true;
	const can = bookingControls({ locked, cancelled, waiting, changed, plan, free, save: saveState, cancel: cancelState });
	const editable = can.editable;
	const set = (next: Partial<BookingForm>) => { setForm({ ...form, ...next }); if (!busy && !uncertain) { saver.clear(); canceller.clear(); } };
	const save = () => {
		if (!can.save || !plan || !('time' in plan)) return;
		const time = plan.time;
		void saver.save((id) => { const w = writes.booking(scope, base.equipmentId, base.id, id, base.revision, time); return { body: w.body, send: () => send(calls, scope, w) }; });
	};
	const note = plan && 'time' in plan
		? `Holds the ${equipmentName} from ${occupancyWords(plan.occupiedFrom, plan.occupiedTo, zone, year)}${form.setup || form.cleanup ? ', with setup and cleanup' : ''}.`
		: null;
	const freeWords = free.kind === 'taken' ? cardCopy.taken(free.holders) : free.kind === 'free' ? cardCopy.free : free.kind === 'checking' ? cardCopy.checking
		: free.kind === 'partial' ? cardCopy.partial : free.kind === 'unchecked' ? cardCopy.unchecked : '';
	const status = cancelState.message || saveState.message;
	const tone = cancelState.message ? cancelState.tone : saveState.tone;
	return <View style={styles.box} testID="booking-editor">
		{cancelled ? <Note tone="neutral" testID="booking-cancelled">{cardCopy.cancelledBooking}</Note> : null}
		<TextField label="Title" testID="booking-title" value={form.title} onChange={(title) => set({ title })} disabled={!editable} maxLength={200} />
		<View style={styles.facts}>
			<SelectField label="Equipment" testID="booking-equipment" value={base.equipmentId} options={[{ value: base.equipmentId, label: equipmentName }]} onChange={() => {}} disabled />
			<DateTimeField label="Date" kind="date" testID="booking-date" value={form.date} onChange={(date) => set(multiDay ? { date } : { date, endDate: date })} disabled={!editable} />
			<DateTimeField label="Start" kind="time" testID="booking-start" value={form.start} onChange={(start) => set({ start })} disabled={!editable} />
			<DateTimeField label="End" kind="time" testID="booking-end" value={form.end} onChange={(end) => set({ end })} disabled={!editable} />
			{multiDay ? <DateTimeField label="End date" kind="date" testID="booking-end-date" value={form.endDate} onChange={(endDate) => set({ endDate })} disabled={!editable} /> : null}
			<SelectField label="Setup" testID="booking-setup" value={String(form.setup)} options={minuteChoices(base.setupMinutes)} onChange={(v) => set({ setup: Number(v) })} disabled={!editable} />
			<SelectField label="Cleanup" testID="booking-cleanup" value={String(form.cleanup)} options={minuteChoices(base.cleanupMinutes)} onChange={(v) => set({ cleanup: Number(v) })} disabled={!editable} />
		</View>
		<Muted>{cardCopy.equipmentFixed}</Muted>
		{!cancelled && plan && 'error' in plan ? <Note tone="warn" testID="booking-invalid">{plan.error}</Note> : null}
		{!cancelled && note ? <Note tone={free.kind === 'taken' ? 'warn' : free.kind === 'free' ? 'ok' : 'neutral'} testID="booking-occupancy">{`${note}${freeWords ? ` ${freeWords}` : ''}`}</Note> : null}
		{cancelled ? null : <View style={styles.row}>
			{saveState.uncertain
				? <><CardButton testID="booking-retry" label="Save again with the same change ID" display="Save again" primary grow disabled={busy || waiting} onPress={() => { void saver.retry(); }} />
					<CardButton testID="booking-discard" label="Discard these changes" display="Discard" disabled={busy} onPress={() => { saver.discard(); }} /></>
				: <><CardButton testID="booking-save" label="Save changes" primary grow disabled={!can.save} onPress={save} />
					{/* Not "Cancel": beside "Cancel this booking" that reads as cancelling the booking (owner, 7 October). */}
					<CardButton testID="booking-cancel-edit" label="Discard your edits" display="Discard edits" disabled={!can.discard} onPress={() => { const f = bookingForm(base, zone); setForm(f); setMultiDay(spansDays(f)); saver.clear(); }} /></>}
		</View>}
		{status ? <Text testID="booking-save-status" role="status" style={tone === 'warn' ? styles.warn : styles.ok}>{status}</Text> : cancelled ? null : <Muted testID="booking-help">{cardCopy.bookingTogether}</Muted>}
		{cancelled ? null : asking
			? <View style={styles.confirm} testID="booking-cancel-confirm">
				<Note tone="warn">{cardCopy.cancelConfirm(equipmentName)}</Note>
				<View style={styles.row}>
					<CardButton testID="booking-cancel-yes" label="Cancel the booking" primary grow disabled={!can.confirmCancel} onPress={() => {
						void canceller.save((id) => { const w = writes.cancelBooking(scope, base.equipmentId, base.id, id, base.revision); return { body: w.body, send: () => send(calls, scope, w) }; }).then(() => { if (!canceller.snapshot().uncertain) setAsking(false); });
					}} />
					{cancelState.uncertain ? <CardButton testID="booking-cancel-retry" label="Cancel again with the same change ID" display="Try again" disabled={busy || waiting} onPress={() => { void canceller.retry().then(() => { if (!canceller.snapshot().uncertain) setAsking(false); }); }} />
						: <CardButton testID="booking-cancel-keep" label="Keep the booking" display="Keep it" disabled={busy} onPress={() => setAsking(false)} />}
				</View>
			</View>
			: <CardButton testID="booking-cancel" label="Cancel this booking" quiet warn disabled={!can.cancel} onPress={() => { canceller.clear(); setAsking(true); }} />}
	</View>;
}

const useStyles = themedStyles((colors) => ({
	box: { gap: 10 },
	facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	confirm: { gap: 8 },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
