/** The booking fields of design board 2 for a booking that does not exist yet: a new booking from the schedule, and a
 *  topic made a booking (bookings contract §3). Equipment, date, start, end (and an end date when it ends on another
 *  day), setup and cleanup, then the note that says what the time will hold and whether the equipment's schedule shows
 *  it free, checked after the person stops typing. Presentation and the occupancy read only: the screen owns the write. */
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import type { ReadScope } from '../../account/contracts.ts';
import type { ThreadCalls } from '../api.ts';
import { themedStyles } from '../../theme/theme.ts';
import { CardButton, DateTimeField, Note, SelectField, type Option } from './Fields.tsx';
import { minuteChoices, occupancyWords, type Availability, type BookingForm, type BookingPlan } from './forms.ts';
import { reads } from './records.ts';
import { cardCopy } from './copy.ts';

/** What the equipment's schedule says about the planned time, re-checked when the slot, the equipment or `again` change
 *  (a refusal: the overlap that refused it is then named). `exclude` is a booking that may already hold the time. */
export function useOccupancy(calls: ThreadCalls, scope: ReadScope, equipmentId: string | null, plan: BookingPlan | null, zone: string | null, year: number, again: unknown): Availability {
	const [free, setFree] = useState<Availability>({ kind: 'idle' });
	const check = useRef(0);
	const slot = equipmentId && plan && 'time' in plan ? `${equipmentId}|${plan.occupiedFrom}|${plan.occupiedTo}` : null;
	useEffect(() => {
		if (!slot || !zone) { check.current++; setFree({ kind: 'idle' }); return; }
		const [equipment, from, to] = slot.split('|') as [string, string, string];
		const n = ++check.current; setFree({ kind: 'checking' });
		const timer = setTimeout(() => { void reads.occupancy(calls, scope, { id: '', equipmentId: equipment }, zone, from, to, year).then((found) => { if (found && n === check.current) setFree(found); }); }, 500);
		return () => clearTimeout(timer);
	}, [slot, zone, again]);
	return free;
}

export function freeWords(free: Availability): string {
	return free.kind === 'taken' ? cardCopy.taken(free.holders) : free.kind === 'free' ? cardCopy.free : free.kind === 'checking' ? cardCopy.checking
		: free.kind === 'partial' ? cardCopy.partial : free.kind === 'unchecked' ? cardCopy.unchecked : '';
}

export function BookingFields({ prefix, form, set, multiDay, setMultiDay, equipment, equipmentId, setEquipment, disabled, plan, free, zone, year }: {
	/** The test id prefix: `new-booking` or `make-booking`. */
	prefix: string; form: BookingForm; set: (next: Partial<BookingForm>) => void; multiDay: boolean; setMultiDay: (v: boolean) => void;
	equipment: readonly Option[]; equipmentId: string | null; setEquipment: (id: string) => void; disabled: boolean;
	plan: BookingPlan | null; free: Availability; zone: string; year: number;
}) {
	const styles = useStyles();
	const name = equipment.find((e) => e.value === equipmentId)?.label ?? 'equipment';
	const note = plan && 'time' in plan
		? `Holds the ${name} from ${occupancyWords(plan.occupiedFrom, plan.occupiedTo, zone, year)}${form.setup || form.cleanup ? ', with setup and cleanup' : ''}.`
		: null;
	const words = freeWords(free);
	return <View style={styles.box}>
		<View style={styles.facts}>
			<SelectField label="Equipment" testID={`${prefix}-equipment`} value={equipmentId ?? ''} options={equipment} onChange={setEquipment} disabled={disabled || equipment.length === 0} />
			<DateTimeField label="Date" kind="date" testID={`${prefix}-date`} value={form.date} onChange={(date) => set(multiDay ? { date } : { date, endDate: date })} disabled={disabled} />
			<DateTimeField label="Start" kind="time" testID={`${prefix}-start`} value={form.start} onChange={(start) => set({ start })} disabled={disabled} />
			<DateTimeField label="End" kind="time" testID={`${prefix}-end`} value={form.end} onChange={(end) => set({ end })} disabled={disabled} />
			{multiDay ? <DateTimeField label="End date" kind="date" testID={`${prefix}-end-date`} value={form.endDate} onChange={(endDate) => set({ endDate })} disabled={disabled} /> : null}
			<SelectField label="Setup" testID={`${prefix}-setup`} value={String(form.setup)} options={minuteChoices(0)} onChange={(v) => set({ setup: Number(v) })} disabled={disabled} />
			<SelectField label="Cleanup" testID={`${prefix}-cleanup`} value={String(form.cleanup)} options={minuteChoices(0)} onChange={(v) => set({ cleanup: Number(v) })} disabled={disabled} />
		</View>
		<CardButton testID={`${prefix}-multi-day`} quiet label={multiDay ? 'Ends the same day' : 'Ends on another day'} disabled={disabled}
			onPress={() => { if (multiDay) set({ endDate: form.date }); setMultiDay(!multiDay); }} />
		{plan && 'error' in plan ? <Note tone="warn" testID={`${prefix}-invalid`}>{plan.error}</Note> : null}
		{note ? <Note tone={free.kind === 'taken' ? 'warn' : free.kind === 'free' ? 'ok' : 'neutral'} testID={`${prefix}-occupancy`}>{`${note}${words ? ` ${words}` : ''}`}</Note> : null}
	</View>;
}

const useStyles = themedStyles(() => ({
	box: { gap: 10 },
	facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }
}));
