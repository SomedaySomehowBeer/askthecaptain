/** The web's organisation memory (docs/plans/expo-web-session-2026-09.md §B.1): the chosen organisation, kept in
 *  `localStorage` under the person's user id. Pure over an injected storage, so node tests use fakes; ./app-web.ts
 *  binds the browser's. Nothing else is stored on the web: the session is the HttpOnly cookie, which JavaScript never
 *  sees, and no token, name or email is written here.
 *
 *  - A missing, disabled or throwing storage (private windows, cleared site data) is not an error: reads answer null
 *    and writes answer false, and the app falls back to the first membership.
 *  - A stored value that is not a canonical organisation id is unusable and reads as null. */
import { isCanonicalUuid } from '../account/session.ts';

/** The part of `window.localStorage` used. */
export type KeyValueStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

export type OrganisationMemory = {
	/** The remembered organisation for `userId`, or null when none usable is stored. */
	read(userId: string): string | null;
	/** Remembers the choice; false when it could not be written (the app still uses the choice for this page). */
	write(userId: string, organisationId: string): boolean;
	forget(userId: string): void;
};

export const organisationMemoryKey = (userId: string): string => `captain.organisation.${userId}`;

export function createOrganisationMemory(storage: () => KeyValueStorage | null): OrganisationMemory {
	const open = (): KeyValueStorage | null => { try { return storage(); } catch { return null; } };
	return Object.freeze({
		read(userId: string): string | null {
			if (!isCanonicalUuid(userId)) return null;
			try {
				const value = open()?.getItem(organisationMemoryKey(userId)) ?? null;
				return isCanonicalUuid(value) ? value : null;
			} catch { return null; }
		},
		write(userId: string, organisationId: string): boolean {
			if (!isCanonicalUuid(userId) || !isCanonicalUuid(organisationId)) return false;
			try { const s = open(); if (s === null) return false; s.setItem(organisationMemoryKey(userId), organisationId); return true; } catch { return false; }
		},
		forget(userId: string): void {
			if (!isCanonicalUuid(userId)) return;
			try { open()?.removeItem(organisationMemoryKey(userId)); } catch { /* nothing usable remains either way */ }
		}
	});
}
