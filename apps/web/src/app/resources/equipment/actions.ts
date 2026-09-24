'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '../../../lib/api.ts';
import { current } from '../../../lib/session.ts';
import { resolveLocal } from './time.ts';
import { uuid, type Equipment, type Reservation } from './types.ts';

/** How a write ended, in the terms a person can act on (D24 equipment contract):
 *  - refused: the API answered 4xx, so nothing changed; keep the form and say why;
 *  - uncertain: no answer, or a 5xx: it may have saved, so check before doing anything else;
 *  - stale: someone else changed the record; reload before editing again;
 *  - exists: that create request id is already used; open the existing record instead. */
export type Outcome<T> =
	| { ok: true; value: T }
	| { ok: false; kind: 'refused' | 'uncertain' | 'stale' | 'exists' | 'conflict'; error: string };

const uncertain = { ok: false, kind: 'uncertain', error: 'Captain could not confirm whether that was saved. Check before doing anything else.' } as const;
const revisionPattern = /^[1-9]\d{0,9}$/;
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

function outcome(error: unknown): Outcome<never> {
	if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) return uncertain;
	if (error.status === 409 && error.code === 'stale_revision') return { ok: false, kind: 'stale', error: 'This changed since you opened it. Reload to see the current version before changing it again.' };
	if (error.status === 409 && error.code === 'reservation_id_exists') return { ok: false, kind: 'exists', error: 'This reservation request was already used. Open the existing reservation to review it.' };
	if (error.status === 409 && error.code === 'reservation_conflict') return { ok: false, kind: 'conflict', error: 'That equipment is unavailable for part of this time, including setup and cleanup. Choose another time; your details are kept.' };
	if (error.status === 404) return { ok: false, kind: 'refused', error: 'Something this refers to is no longer available: the equipment, the reservation, or a linked project, task or person. Check the choices and try again.' };
	return { ok: false, kind: 'refused', error: error.message };
}

async function session() {
	const me = await current();
	return me?.organisation ? { token: me.token, org: me.organisation.organisationId } : null;
}
const signedOut = { ok: false, kind: 'refused', error: 'Your session has ended. Sign in again; nothing was saved.' } as const;

function refresh(equipmentId?: string, reservationId?: string) {
	revalidatePath('/resources/equipment'); revalidatePath('/resources/equipment/manage');
	if (equipmentId && reservationId) revalidatePath(`/resources/equipment/${equipmentId}/reservations/${reservationId}`);
}

// Equipment catalogue

export async function createEquipment(form: FormData): Promise<Outcome<Equipment>> {
	const name = text(form, 'name');
	if (!name || name.length > 100) return { ok: false, kind: 'refused', error: 'Give the equipment a name of up to 100 characters.' };
	const s = await session(); if (!s) return signedOut;
	try {
		const value = await api<Equipment>(`/v1/organisations/${s.org}/equipment`, { method: 'POST', token: s.token, body: { name } });
		refresh(); return { ok: true, value };
	} catch (error) { return outcome(error); }
}

/** Rename, archive or restore, always against the revision the person saw. */
export async function updateEquipment(form: FormData): Promise<Outcome<Equipment>> {
	const id = text(form, 'id'); const revision = text(form, 'expectedRevision'); const change = text(form, 'change');
	if (!uuid.test(id) || !revisionPattern.test(revision)) return { ok: false, kind: 'refused', error: 'That equipment reference is not valid. Reload the list.' };
	let body: Record<string, unknown>;
	if (change === 'rename') {
		const name = text(form, 'name');
		if (!name || name.length > 100) return { ok: false, kind: 'refused', error: 'Give the equipment a name of up to 100 characters.' };
		body = { name };
	} else if (change === 'archive' || change === 'restore') body = { archived: change === 'archive' };
	else return { ok: false, kind: 'refused', error: 'That change was not understood.' };
	const s = await session(); if (!s) return signedOut;
	try {
		const value = await api<Equipment>(`/v1/organisations/${s.org}/equipment/${id}`, { method: 'PATCH', token: s.token, body: { expectedRevision: Number(revision), ...body } });
		refresh(); return { ok: true, value };
	} catch (error) {
		if (error instanceof ApiError && error.status === 409 && error.code === 'equipment_in_use')
			return { ok: false, kind: 'refused', error: 'This equipment has current or upcoming reservations. Cancel them before archiving it.' };
		if (error instanceof ApiError && error.status === 409 && error.code === 'equipment_name_exists')
			return { ok: false, kind: 'refused', error: error.message };
		return outcome(error);
	}
}

// Reservations

/** The organisation's timezone is read here, on the server, for every write: never the browser's
 *  and never a value posted by the form. */
async function timezone(s: { token: string; org: string }) {
	return (await api<{ timezone: string }>(`/v1/organisations/${s.org}`, { token: s.token })).timezone;
}

/** Local form values to the API's schedule, resolving each local time in the organisation's zone.
 *  Every time is resolved from what the form shows, including a chosen repeated-hour occurrence;
 *  `localValue` keeps stored seconds and milliseconds, so an untouched time resolves to itself. */
function schedule(form: FormData, timeZone: string): Record<string, unknown> | { error: string } {
	const title = text(form, 'title'); const kind = text(form, 'kind');
	if (!title || title.length > 200) return { error: 'Give the reservation a title of up to 200 characters.' };
	if (kind !== 'booking' && kind !== 'maintenance') return { error: 'Choose booking or maintenance.' };
	const minutes = (key: string) => { const value = text(form, key) || '0'; return /^\d{1,5}$/.test(value) && Number(value) <= 10080 ? Number(value) : null; };
	const setupMinutes = minutes('setupMinutes'); const cleanupMinutes = minutes('cleanupMinutes');
	if (setupMinutes === null || cleanupMinutes === null) return { error: 'Setup and cleanup are whole minutes from 0 to 10,080 (seven days).' };
	const instant = (which: 'starts' | 'ends') => resolveLocal(text(form, `${which}Local`), timeZone, text(form, `${which}Choice`) || undefined);
	let startsAt: string, endsAt: string;
	try { startsAt = instant('starts'); endsAt = instant('ends'); }
	catch (error) { return { error: error instanceof Error ? error.message : 'Give the start and end as dates and times.' }; }
	if (Date.parse(endsAt) <= Date.parse(startsAt)) return { error: 'The end must be after the start.' };
	const link = (key: string) => { const value = text(form, key); return value ? value : null; };
	const projectId = link('projectId'); const taskId = link('taskId'); const ownerId = link('ownerId');
	for (const value of [projectId, taskId, ownerId]) if (value !== null && !uuid.test(value)) return { error: 'A linked project, task or person is not valid. Choose again.' };
	if (taskId && !projectId) return { error: 'Choose the task’s project as well.' };
	return { title, kind, startsAt, endsAt, setupMinutes, cleanupMinutes, projectId, taskId, ownerId };
}

export async function createReservation(form: FormData): Promise<Outcome<Reservation>> {
	const equipmentId = text(form, 'equipmentId'); const id = text(form, 'id');
	if (!uuid.test(equipmentId) || !uuid.test(id)) return { ok: false, kind: 'refused', error: 'That reservation form is not valid. Open it again from the schedule.' };
	const s = await session(); if (!s) return signedOut;
	let zone: string;
	try { zone = await timezone(s); } catch { return { ok: false, kind: 'refused', error: 'The organisation’s timezone could not be read, so nothing was sent. Try again.' }; }
	// The times were typed against the zone the form showed; never reinterpret them in another.
	if (text(form, 'timeZone') !== zone) return { ok: false, kind: 'stale', error: `The organisation’s timezone is now ${zone}, not the one this form showed. Reload the form and check the times; nothing was saved.` };
	const body = schedule(form, zone);
	if ('error' in body) return { ok: false, kind: 'refused', error: String(body.error) };
	try {
		const value = await api<Reservation>(`/v1/organisations/${s.org}/equipment/${equipmentId}/reservations`, { method: 'POST', token: s.token, body: { id, ...body } });
		refresh(equipmentId, value.id); return { ok: true, value };
	} catch (error) { return outcome(error); }
}

export async function replaceReservation(form: FormData): Promise<Outcome<Reservation>> {
	const equipmentId = text(form, 'equipmentId'); const id = text(form, 'reservationId'); const revision = text(form, 'expectedRevision');
	if (!uuid.test(equipmentId) || !uuid.test(id) || !revisionPattern.test(revision)) return { ok: false, kind: 'refused', error: 'That reservation form is not valid. Reload it.' };
	const s = await session(); if (!s) return signedOut;
	let zone: string;
	try { zone = await timezone(s); } catch { return { ok: false, kind: 'refused', error: 'The organisation’s timezone could not be read, so nothing was sent. Try again.' }; }
	// The times were typed against the zone the form showed; never reinterpret them in another.
	if (text(form, 'timeZone') !== zone) return { ok: false, kind: 'stale', error: `The organisation’s timezone is now ${zone}, not the one this form showed. Reload the form and check the times; nothing was saved.` };
	const body = schedule(form, zone);
	if ('error' in body) return { ok: false, kind: 'refused', error: String(body.error) };
	try {
		const value = await api<Reservation>(`/v1/organisations/${s.org}/equipment/${equipmentId}/reservations/${id}`, { method: 'PATCH', token: s.token, body: { expectedRevision: Number(revision), ...body } });
		refresh(equipmentId, id); return { ok: true, value };
	} catch (error) {
		if (error instanceof ApiError && error.status === 409 && (error.code === 'reservation_cancelled' || error.code === 'equipment_archived'))
			return { ok: false, kind: 'stale', error: `${error.message} Reload to see where it stands.` };
		return outcome(error);
	}
}

export async function cancelReservation(form: FormData): Promise<Outcome<Reservation>> {
	const equipmentId = text(form, 'equipmentId'); const id = text(form, 'reservationId'); const revision = text(form, 'expectedRevision');
	if (!uuid.test(equipmentId) || !uuid.test(id) || !revisionPattern.test(revision)) return { ok: false, kind: 'refused', error: 'That reservation is not valid. Reload it.' };
	const s = await session(); if (!s) return signedOut;
	try {
		const value = await api<Reservation>(`/v1/organisations/${s.org}/equipment/${equipmentId}/reservations/${id}/cancel`, { method: 'POST', token: s.token, body: { expectedRevision: Number(revision) } });
		refresh(equipmentId, id); return { ok: true, value };
	} catch (error) { return outcome(error); }
}

/** After an uncertain create, read the one record by its request id: it either exists (open it),
 *  is missing (the same request can be sent again), or cannot be read yet (stay pending). */
export async function checkReservation(equipmentId: string, id: string): Promise<{ state: 'found'; reservation: Reservation } | { state: 'missing' | 'unavailable' }> {
	if (!uuid.test(equipmentId) || !uuid.test(id)) return { state: 'unavailable' };
	const s = await session(); if (!s) return { state: 'unavailable' };
	try { return { state: 'found', reservation: await api<Reservation>(`/v1/organisations/${s.org}/equipment/${equipmentId}/reservations/${id}`, { token: s.token }) }; }
	catch (error) { return error instanceof ApiError && error.status === 404 ? { state: 'missing' } : { state: 'unavailable' }; }
}
