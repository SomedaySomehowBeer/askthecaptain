'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '../../lib/api.ts';
import { actionSession } from '../../lib/session.ts';
import { isViewId, readFilter, sameScope, viewName, type SavedFilter, type SavedView, type ViewScope } from './saved-views.ts';

/** How a saved-view write ended. Only `uncertain` may have changed something without saying so:
 *  the caller keeps its identity and payload and offers a same-identity retry or a read. */
export type ViewResult =
	| { ok: true; view: SavedView | null }
	| { ok: false; kind: 'not-sent'; error: string }
	| { ok: false; kind: 'refused'; code: string; error: string }
	| { ok: false; kind: 'id-unavailable'; error: string }
	| { ok: false; kind: 'stale'; current: SavedView | null; error: string }
	| { ok: false; kind: 'gone'; error: string }
	| { ok: false; kind: 'uncertain'; error: string }
	| { ok: false; kind: 'wrong-scope'; error: string };
export type ViewRead = { ok: true; view: SavedView } | { ok: false; kind: 'gone' | 'unreadable' | 'not-sent' | 'wrong-scope'; error: string };

const wrongScope = 'This page was opened for a different sign-in or organisation than the one now active in this browser, so nothing was sent. Reload the page to continue in the current organisation.';

/** The session to write with, only when it is the person and organisation the page was rendered for. Checked before
 *  any API call: the organisation cookie is shared by every tab, so another tab may have switched it. */
async function scopedSession(scope: unknown) {
	const session = await actionSession();
	if (!session.ok) return { ok: false as const, kind: 'not-sent' as const, error: session.error };
	if (!sameScope(scope, { userId: session.current.me.user.id, organisationId: session.org })) return { ok: false as const, kind: 'wrong-scope' as const, error: wrongScope };
	return session;
}

const uncertain = 'Captain could not confirm whether that was saved.';
const words: Record<string, string> = {
	view_name_exists: 'You already have a view with that name. Choose another name.',
	view_limit: 'You have 50 saved views, the most Captain keeps. Delete one before saving another.',
	invalid_filter: 'Captain could not accept this filter. Change it and try again.',
	view_id_unavailable: 'This save could not use its reserved identity. The view may have been saved and then changed or deleted elsewhere.'
};

function refresh() { revalidatePath('/work'); revalidatePath('/work/views'); }
const path = (org: string, id?: string) => `/v1/organisations/${org}/views${id ? `/${id}` : ''}`;

async function read(token: string, org: string, id: string): Promise<ViewRead> {
	try { return { ok: true, view: await api<SavedView>(path(org, id), { token }) }; }
	catch (error) {
		if (error instanceof ApiError && error.status === 404) return { ok: false, kind: 'gone', error: 'This saved view is not available.' };
		return { ok: false, kind: 'unreadable', error: error instanceof ApiError ? error.message : 'The saved view could not be read.' };
	}
}

/** Map a failed write. A 4xx refusal means nothing changed; anything else may have saved. */
async function failed(error: unknown, token: string, org: string, id: string): Promise<ViewResult> {
	if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.status < 400) return { ok: false, kind: 'uncertain', error: uncertain };
	if (error.status === 404) return { ok: false, kind: 'gone', error: 'This saved view is no longer available. It may have been deleted in another tab.' };
	if (error.code === 'stale_revision') {
		const latest = await read(token, org, id);
		return { ok: false, kind: 'stale', current: latest.ok ? latest.view : null, error: 'This view was changed in another tab or on another device since you opened it.' };
	}
	if (error.code === 'view_id_unavailable') return { ok: false, kind: 'id-unavailable', error: words.view_id_unavailable! };
	if (error.status === 401) return { ok: false, kind: 'not-sent', error: 'Your session has ended. Sign in again, then check the view before saving again.' };
	return { ok: false, kind: 'refused', code: error.code, error: words[error.code] ?? error.message };
}

function checkFilter(value: unknown): SavedFilter | { error: string } {
	const filter = readFilter(value);
	return filter.ok ? filter.filter : { error: filter.problem };
}

/** Create with the caller's id. The same id and payload may be sent again after an uncertain result;
 *  the API returns the stored view for an identical retry and never resurrects a deleted one. */
export async function createView(input: { id: string; name: string; filter: SavedFilter; scope: ViewScope }): Promise<ViewResult> {
	if (!isViewId(input.id)) return { ok: false, kind: 'refused', code: 'invalid', error: 'This save has no valid identity. Close the form and start again.' };
	const name = viewName(input.name); if (typeof name !== 'string') return { ok: false, kind: 'refused', code: 'invalid_name', error: name.error };
	const filter = checkFilter(input.filter); if ('error' in filter) return { ok: false, kind: 'refused', code: 'invalid_filter', error: filter.error };
	const session = await scopedSession(input.scope);
	if (!session.ok) return session;
	const id = input.id.toLowerCase();
	try {
		const view = await api<SavedView>(path(session.org), { method: 'POST', token: session.token, body: { id, name, filter } });
		refresh();
		return { ok: true, view };
	} catch (error) {
		// A create has no view to lose: its 404 means the person is no longer an active member here. Nothing was written.
		if (error instanceof ApiError && error.status === 404) return { ok: false, kind: 'refused', code: 'not_found', error: 'You no longer have access to this organisation’s Work, so nothing was saved. Reload the page to check your access.' };
		return failed(error, session.token, session.org, id);
	}
}

/** Rename or change the filter from the revision the person's edit was based on. */
export async function updateView(input: { id: string; expectedRevision: number; name?: string; filter?: SavedFilter; scope: ViewScope }): Promise<ViewResult> {
	if (!isViewId(input.id) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) return { ok: false, kind: 'refused', code: 'invalid', error: 'That saved view reference is not valid. Reload the view.' };
	const body: { expectedRevision: number; name?: string; filter?: SavedFilter } = { expectedRevision: input.expectedRevision };
	if (input.name !== undefined) { const name = viewName(input.name); if (typeof name !== 'string') return { ok: false, kind: 'refused', code: 'invalid_name', error: name.error }; body.name = name; }
	if (input.filter !== undefined) { const filter = checkFilter(input.filter); if ('error' in filter) return { ok: false, kind: 'refused', code: 'invalid_filter', error: filter.error }; body.filter = filter; }
	if (body.name === undefined && body.filter === undefined) return { ok: false, kind: 'refused', code: 'invalid', error: 'Nothing to change.' };
	const session = await scopedSession(input.scope);
	if (!session.ok) return session;
	const id = input.id.toLowerCase();
	try {
		const view = await api<SavedView>(path(session.org, id), { method: 'PATCH', token: session.token, body });
		refresh();
		return { ok: true, view };
	} catch (error) { return failed(error, session.token, session.org, id); }
}

/** Delete tombstones the view (the id stays reserved). A second delete is 404. */
export async function deleteView(input: { id: string; expectedRevision: number; scope: ViewScope }): Promise<ViewResult> {
	if (!isViewId(input.id) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) return { ok: false, kind: 'refused', code: 'invalid', error: 'That saved view reference is not valid. Reload the view.' };
	const session = await scopedSession(input.scope);
	if (!session.ok) return session;
	const id = input.id.toLowerCase();
	try {
		await api<{ ok: true }>(`${path(session.org, id)}?expectedRevision=${input.expectedRevision}`, { method: 'DELETE', token: session.token });
		refresh();
		return { ok: true, view: null };
	} catch (error) { return failed(error, session.token, session.org, id); }
}

/** Read one view by id, to reconcile an uncertain write. */
export async function checkView(id: string, scope: ViewScope): Promise<ViewRead> {
	if (!isViewId(id)) return { ok: false, kind: 'gone', error: 'That saved view reference is not valid.' };
	// A read in another organisation would say "not found" about a view that may exist here; refuse it instead.
	const session = await scopedSession(scope);
	if (!session.ok) return session;
	return read(session.token, session.org, id.toLowerCase());
}
