/** Tag pages are read with GET, so their only state is a bounded `offset` in the URL. The API
 *  accepts at most 100 per page and offsets up to 1,000,000; Work asks for 50 at a time. */
export const tagPageSize = 50;
export const maxTagOffset = 1_000_000;
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The offset in the URL, or null when it is not a page this list can have. Absent means the first page. */
export function parseTagOffset(value: string | string[] | undefined): number | null {
	if (value === undefined || value === '') return 0;
	if (Array.isArray(value) || !/^\d{1,7}$/.test(value)) return null;
	const offset = Number(value);
	return offset <= maxTagOffset && offset % tagPageSize === 0 ? offset : null;
}

/** A link to another page of the same list, or null when the API could not serve it. */
export function tagPageHref(path: string, offset: number | null): string | null {
	if (offset === null || offset < 0 || offset > maxTagOffset) return null;
	return offset === 0 ? path : `${path}?offset=${offset}`;
}

/** Label names as the API accepts them: trimmed, 1 to 60 characters. */
export function tagName(value: FormDataEntryValue | null): string | { error: string } {
	const name = String(value ?? '').trim();
	if (!name) return { error: 'Give the tag a name.' };
	if (name.length > 60) return { error: 'Keep the tag name to 60 characters.' };
	return name;
}
