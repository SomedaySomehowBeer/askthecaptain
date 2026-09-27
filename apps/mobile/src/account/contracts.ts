/** Contracts for the serialised credential store (M-auth; docs/plans/expo-mobile-foundation-2026-09.md §4,
 *  docs/plans/expo-mobile-auth-core-2026-09.md). Types and the two error
 *  classes only: no React Native or platform import, so the store and its node tests build on it. Opaque token handles,
 *  the account reducer and its effect runner are in machine.ts and runner.ts.
 *
 *  Rules these types carry:
 *  - Every credential storage operation goes through one CredentialStore, strictly one at a time, first in, first out.
 *    Nothing else calls SessionStorage.
 *  - A write checks the generation when it actually runs, so a stale sign-in or organisation choice writes nothing.
 *  - A delete compares first, so a slow removal for an old session or organisation can never erase a newer one.
 *  - A failed operation rejects only its own promise; the operations queued behind it still run.
 *  - A stored value that does not match the exact schema and field formats is unreadable. It is never guessed at, repaired or
 *    deleted: it stays unreadable until a deliberate new save (a sign-in's install, or setOrg) replaces it.
 *  - Errors never carry a token, a stored value or a platform message: only which kind of failure it was.
 *  - "Nothing stored" (a null read, or 'absent') means no usable value was returned, not proof that no bytes remain:
 *    iOS returns nothing for an item that is not valid text, and Android can return nothing for an entry its key can
 *    no longer decrypt. Such a value holds no usable token, so it counts as no saved sign-in, and wording says "no
 *    usable saved sign-in", never "nothing was stored". */

/** Advanced by the account machine: `account` on sign-in (before the new session is installed), sign-out, session end
 *  and account switch; `organisation` on every organisation change, including loss. */
export type Generation = { readonly account: number; readonly organisation: number };

/** The only credential this app keeps on the device (contract §4: key `session`). `token` is the API's session token
 *  (`sess_` and 43 base64url characters), `expiresAt` the API's ISO instant (`YYYY-MM-DDTHH:mm:ss.sssZ`) and `userId` a
 *  canonical lower-case UUID. An expired session is still a well-formed value; expiry is the caller's decision. */
export type StoredSession = { readonly token: string; readonly expiresAt: string; readonly userId: string };

/** The stored value could not be read, or does not match the exact schema and field formats. */
export class StorageUnreadable extends Error {
	constructor() { super('The saved sign-in on this device could not be read.'); this.name = 'StorageUnreadable'; }
}
/** A write or delete did not complete. After a failed delete the saved copy may still be on the device. */
export class StorageUnwritable extends Error {
	constructor() { super('The saved sign-in on this device could not be changed.'); this.name = 'StorageUnwritable'; }
}

/** `session`, or `org.{userId}` for a person's organisation choice (userId a canonical UUID). */
export type StorageKey = 'session' | `org.${string}`;

/** The raw device storage: a thin adapter over expo-secure-store with WHEN_UNLOCKED_THIS_DEVICE_ONLY. It stores and
 *  returns strings exactly; the store parses and validates them. Any rejection, with any error, is replaced by the
 *  store with StorageUnreadable or StorageUnwritable, so a platform message never travels further. Only the
 *  CredentialStore calls it. */
export type SessionStorage = {
	/** The stored string, or null when no usable value is returned under `key` (see "Nothing stored" above). */
	getItem(key: StorageKey): Promise<string | null>;
	setItem(key: StorageKey, value: string): Promise<void>;
	/** Resolves when nothing is stored under `key`, including when nothing was. */
	deleteItem(key: StorageKey): Promise<void>;
};

/** The single, serial path to credential storage. Arguments are checked before anything is queued: an invalid one
 *  rejects with a TypeError whose fixed message never repeats the value, and nothing is read or written. */
export type CredentialStore = {
	/** The stored session, or null when no usable one was returned. Throws StorageUnreadable. */
	read(): Promise<StoredSession | null>;
	/** Writes `session`, replacing whatever is stored (an unreadable value included), only if the account generation
	 *  is still `generation.account` when this operation runs. An organisation change alone never makes it stale.
	 *  Otherwise writes nothing and answers 'stale': that session is live on the server, so the caller must revoke it.
	 *  Throws StorageUnwritable. */
	install(session: StoredSession, generation: Generation): Promise<'written' | 'stale'>;
	/** Deletes the stored session only if it still holds exactly `token` (plain equality inside the private queue; no
	 *  timing claim is made on the device, and the server's handoff binding keeps its own timing rule).
	 *  'absent': no usable saved sign-in was returned. 'newer-kept': another session is stored and was left alone. Throws
	 *  StorageUnreadable if the comparison read fails or the stored value is unreadable, or StorageUnwritable if the
	 *  delete fails: in each case the saved copy may remain, and the caller must never report 'absent' or 'deleted'. */
	removeIf(token: string): Promise<'deleted' | 'absent' | 'newer-kept'>;
	/** The stored organisation choice for `userId`, or null when no usable one was returned. Throws StorageUnreadable. */
	readOrg(userId: string): Promise<string | null>;
	/** Writes the organisation choice only if both the account and the organisation generation are still those of
	 *  `generation` when this operation runs; otherwise writes nothing and answers 'stale'. Throws StorageUnwritable. */
	setOrg(userId: string, organisationId: string, generation: Generation): Promise<'written' | 'stale'>;
	/** Deletes the choice only if it is still exactly `organisationId`. 'absent': no usable choice was returned.
	 *  'other-kept': another choice was left alone.
	 *  Throws StorageUnreadable (including an unreadable stored choice) or StorageUnwritable: the stored choice may
	 *  remain. */
	forgetOrgIf(userId: string, organisationId: string): Promise<'deleted' | 'absent' | 'other-kept'>;
	/** Resolves 'settled' once every operation queued before this call has finished, or 'timed-out' after `timeoutMs`
	 *  (a whole number of milliseconds). Operations queued after the call are not waited for: the caller holds new
	 *  sign-ins back itself before calling. A timeout cancels nothing: the operations keep running, and no claim about
	 *  the stored copy follows from it. */
	settled(timeoutMs: number): Promise<'settled' | 'timed-out'>;
};

/** How the store is built: over the raw storage, reading the account machine's current generation at the moment each
 *  generation-checked operation actually runs (not when it was queued). */
export type CreateCredentialStore = (storage: SessionStorage, currentGeneration: () => Generation) => CredentialStore;
