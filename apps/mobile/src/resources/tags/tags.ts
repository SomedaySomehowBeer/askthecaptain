/** The Tags screens' reads and writes (H4 contract §3): every tag with the caller's visible thread count, one tag, and the
 *  revision-checked, journalled writes a person makes there (add, rename, owner and dates, archive or restore). Each write
 *  carries a client change set id and answers with it (versions contract §5). A tag with an owner or dates is what makes
 *  it a project (D7). Strict parsers: one bad row refuses the answer. Shapes follow apps/api/src/tags/service.ts. Pure:
 *  no React Native import, so Node tests import it. */
import type { ReadScope } from '../../account/contracts.ts';
import { isCanonicalInstant, organisationPath } from '../../api/paths.ts';
import { queryPath } from '../../threads/api.ts';
import type { Write } from '../../threads/cards/records.ts';
import { array, integer, keys, object, text, uuid } from '../../threads/parse.ts';

const bad = (): never => { throw new TypeError('tags: unexpected response'); };
const instant = (x: unknown): string => isCanonicalInstant(x) ? x : bad();
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && isCanonicalInstant(`${v}T00:00:00.000Z`);
const date = (x: unknown): string | null => x === null ? null : typeof x === 'string' && isDate(x) ? x : bad();

export type ManagedTag = { readonly id: string; readonly name: string; readonly ownerId: string | null; readonly startsOn: string | null; readonly endsOn: string | null;
	readonly archivedAt: string | null; readonly revision: number; readonly threads: number | null };
const tagKeys = ['id', 'name', 'ownerId', 'startsOn', 'endsOn', 'archivedAt', 'revision', 'createdBy', 'createdAt', 'updatedAt'];

/** One tag. `threads` is the caller's visible thread count where the answer has one (the list with counts, one tag). */
export function parseManagedTag(raw: unknown, extra: string[] = []): ManagedTag {
	const x = object(raw); keys(x, tagKeys, extra);
	instant(x.createdAt); instant(x.updatedAt); if (x.createdBy !== null) uuid(x.createdBy);
	const name = text(x.name, 120);
	if (!name.trim() || name !== name.trim()) bad();
	const t = { id: uuid(x.id), name, ownerId: x.ownerId === null ? null : uuid(x.ownerId), startsOn: date(x.startsOn), endsOn: date(x.endsOn),
		archivedAt: x.archivedAt === null ? null : instant(x.archivedAt), revision: integer(x.revision, 1), threads: x.threads === undefined ? null : integer(x.threads) };
	if (t.startsOn && t.endsOn && t.endsOn < t.startsOn) bad();
	return Object.freeze(t);
}
export type TagCatalogue = { readonly tags: readonly ManagedTag[]; readonly more: boolean };
export const tagPageSize = 100;
/** `GET …/tags?counts=true&offset=0&limit=100`: every row with its count, unique ids, in the API's name order. */
export function parseTagCatalogue(raw: unknown): TagCatalogue {
	const x = object(raw); keys(x, ['tags', 'nextOffset']);
	const tags = array(x.tags, (row) => { const t = parseManagedTag(row, ['threads']); if (t.threads === null) bad(); return t; }, tagPageSize);
	if (new Set(tags.map((t) => t.id)).size !== tags.length) bad();
	if (x.nextOffset !== null && (x.nextOffset !== tagPageSize || tags.length !== tagPageSize)) bad();
	return Object.freeze({ tags: Object.freeze(tags), more: x.nextOffset !== null });
}
export const tagCataloguePath = (scope: ReadScope) => queryPath(organisationPath(scope.organisationId, 'tags'), { counts: 'true', offset: 0, limit: tagPageSize });
export const tagPath = (scope: ReadScope, tagId: string) => organisationPath(scope.organisationId, 'tags', uuid(tagId));
/** `GET …/tags/:id`: the tag asked for, with its count. */
export function parseOneTag(raw: unknown, tagId: string): ManagedTag {
	const t = parseManagedTag(raw, ['threads']);
	if (t.id !== tagId || t.threads === null) bad();
	return t;
}
/** A write's answer: the tag asked about, with the change set sent, and the values asked for. */
export function parseTagWrite(raw: unknown, expected: { id?: string; changeSetId: string; patch: TagPatch }): ManagedTag & { changeSetId: string } {
	const x = object(raw); const t = parseManagedTag(x, ['changeSetId']);
	if (uuid(x.changeSetId) !== expected.changeSetId || (expected.id && t.id !== expected.id)) bad();
	const p = expected.patch;
	if ((p.name !== undefined && t.name !== p.name) || (p.ownerId !== undefined && t.ownerId !== p.ownerId) || (p.startsOn !== undefined && t.startsOn !== p.startsOn)
		|| (p.endsOn !== undefined && t.endsOn !== p.endsOn) || (p.archived !== undefined && (t.archivedAt !== null) !== p.archived)) bad();
	return { ...t, changeSetId: expected.changeSetId };
}

export type TagForm = { name: string; ownerId: string; startsOn: string; endsOn: string };
export type TagPatch = { name?: string; ownerId?: string | null; startsOn?: string | null; endsOn?: string | null; archived?: boolean };
export const tagForm = (t: ManagedTag): TagForm => ({ name: t.name, ownerId: t.ownerId ?? '', startsOn: t.startsOn ?? '', endsOn: t.endsOn ?? '' });
export const emptyTagForm: TagForm = { name: '', ownerId: '', startsOn: '', endsOn: '' };
/** What is wrong with the form, in words; null when it can be saved. The API's rules: a name of 1 to 120 characters,
 *  real dates or none, and the end not before the start. */
export function tagProblem(form: TagForm): string | null {
	const name = form.name.trim();
	if (!name) return 'Enter a name for the tag.';
	if ([...name].length > 120) return 'A name is at most 120 characters.';
	if ((form.startsOn && !isDate(form.startsOn)) || (form.endsOn && !isDate(form.endsOn))) return 'Enter the dates as dates, or leave them empty.';
	if (form.startsOn && form.endsOn && form.endsOn < form.startsOn) return 'The end date cannot be before the start date.';
	return null;
}
/** Only what changed, so one save is one change set naming the fields the person touched; null when nothing did. */
export function tagChanges(tag: ManagedTag, form: TagForm): TagPatch | null {
	const p: TagPatch = {};
	if (form.name.trim() !== tag.name) p.name = form.name.trim();
	if ((form.ownerId || null) !== tag.ownerId) p.ownerId = form.ownerId || null;
	if ((form.startsOn || null) !== tag.startsOn) p.startsOn = form.startsOn || null;
	if ((form.endsOn || null) !== tag.endsOn) p.endsOn = form.endsOn || null;
	return Object.keys(p).length ? p : null;
}
/** A tag's line under its name: owner and dates when set ("Maya Chen · 1 Jun – 31 Aug 2031"), its thread count. */
export function tagDetail(tag: ManagedTag, ownerName: string | null, dates: string): string {
	return [tag.ownerId ? ownerName ?? 'Former member' : null, dates || null, tag.threads === null ? null : `${tag.threads} ${tag.threads === 1 ? 'thread' : 'threads'}`, tag.archivedAt ? 'Archived' : null]
		.filter(Boolean).join(' · ');
}

export const tagWrites = {
	add: (scope: ReadScope, changeSetId: string, form: TagForm): Write<ManagedTag & { changeSetId: string }> => {
		const patch: TagPatch = { name: form.name.trim(), ...(form.ownerId ? { ownerId: form.ownerId } : {}), ...(form.startsOn ? { startsOn: form.startsOn } : {}), ...(form.endsOn ? { endsOn: form.endsOn } : {}) };
		return { method: 'POST', path: organisationPath(scope.organisationId, 'tags'), body: { changeSetId, ...patch }, parse: (v) => parseTagWrite(v, { changeSetId, patch: { ...patch, archived: false } }) };
	},
	update: (scope: ReadScope, tag: ManagedTag, changeSetId: string, patch: TagPatch): Write<ManagedTag & { changeSetId: string }> =>
		({ method: 'PATCH', path: tagPath(scope, tag.id), body: { changeSetId, expectedRevision: tag.revision, ...patch }, parse: (v) => parseTagWrite(v, { id: tag.id, changeSetId, patch }) })
};
/** Refusals these writes document, in words (the saver's general copy covers the rest). */
export const tagRefusals: Readonly<Record<string, string>> = Object.freeze({
	tag_name_exists: 'A tag with that name already exists, including archived tags. Choose another name.',
	tag_dates_invalid: 'The end date cannot be before the start date.',
	owner_invalid: 'The owner must be an active member of this organisation.'
});
export const tagsCopy = {
	heading: 'Tags',
	help: 'Tags group threads in the list. A tag with an owner or dates is a project. Archiving a tag keeps it on its threads but removes its heading from the list.',
	section: 'Active tags', archivedSection: 'Archived tags',
	loading: 'Loading the tags…', failed: 'Couldn’t load the tags. Try again.', wait: 'Captain asked you to wait before loading this again.',
	lost: 'This organisation’s tags are no longer available to you.', empty: 'No tags yet. Add the first below.', more: 'Only the first 100 tags are shown.',
	add: 'Add a tag', addHeading: 'Add a tag', name: 'Name', owner: 'Owner', noOwner: 'No owner', starts: 'Starts', ends: 'Ends',
	write: { saving: 'Saving…', saved: 'Saved. The change is in the tag’s history.', confirmed: 'Change confirmed.', refusals: tagRefusals },
	detailHeading: 'Tag', detailLost: 'This tag is no longer available.', save: 'Save changes', discard: 'Discard edits',
	archiveConfirm: (name: string) => `Archive ${name}? Its heading leaves the thread list and it can’t be added to more threads. Threads keep it. You can restore it later.`,
	restoreConfirm: (name: string) => `Restore ${name}? Its heading returns to the thread list.`,
	countsNote: 'Counts are the threads you can see.'
} as const;
