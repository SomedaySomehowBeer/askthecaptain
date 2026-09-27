import {
	StorageUnreadable, StorageUnwritable,
	type CreateCredentialStore, type Generation, type StorageKey
} from './contracts.ts';
import {
	isCanonicalUuid, isSessionToken, isStoredSession, organisationKey, parseOrganisationId, parseStoredSession,
	serialiseSession, sessionKey
} from './session.ts';

/** The largest delay a timer accepts (2^31 − 1 ms). */
const longestTimeout = 2_147_483_647;

const refused = (what: string) => Promise.reject(new TypeError(`credential store: ${what}`));
const isGeneration = (value: unknown): value is Generation =>
	typeof value === 'object' && value !== null &&
	Number.isSafeInteger((value as Generation).account) && Number.isSafeInteger((value as Generation).organisation);

/** The serialised credential store (contracts.ts). One queue: each operation starts only after the one before it has
 *  finished, whether that succeeded or failed. */
export const createCredentialStore: CreateCredentialStore = (storage, currentGeneration) => {
	let tail: Promise<void> = Promise.resolve();
	let outstanding = 0;
	const finished = () => { outstanding -= 1; };

	function enqueue<T>(operation: () => Promise<T>): Promise<T> {
		outstanding += 1;
		const result = tail.then(operation);
		tail = result.then(finished, finished);
		return result;
	}

	// Every platform failure becomes one fixed error: its message, code and stack stay here.
	async function get(key: StorageKey): Promise<string | null> {
		let raw: unknown;
		try { raw = await storage.getItem(key); } catch { throw new StorageUnreadable(); }
		if (raw !== null && typeof raw !== 'string') throw new StorageUnreadable();
		return raw;
	}
	async function set(key: StorageKey, value: string): Promise<void> {
		try { await storage.setItem(key, value); } catch { throw new StorageUnwritable(); }
	}
	async function remove(key: StorageKey): Promise<void> {
		try { await storage.deleteItem(key); } catch { throw new StorageUnwritable(); }
	}

	return {
		read: () => enqueue(async () => {
			const raw = await get(sessionKey);
			return raw === null ? null : parseStoredSession(raw);
		}),

		install(session, generation) {
			if (!isStoredSession(session)) return refused('the session is not a valid stored session');
			if (!isGeneration(generation)) return refused('the generation is not valid');
			const value = serialiseSession(session); const account = generation.account;
			return enqueue(async () => {
				if (currentGeneration().account !== account) return 'stale' as const;
				await set(sessionKey, value);
				return 'written' as const;
			});
		},

		removeIf(token) {
			if (!isSessionToken(token)) return refused('the token is not a session token');
			return enqueue(async () => {
				const raw = await get(sessionKey);
				if (raw === null) return 'absent' as const;
				if (parseStoredSession(raw).token !== token) return 'newer-kept' as const;
				await remove(sessionKey);
				return 'deleted' as const;
			});
		},

		readOrg(userId) {
			if (!isCanonicalUuid(userId)) return refused('the user ID is not a canonical UUID');
			return enqueue(async () => {
				const raw = await get(organisationKey(userId));
				return raw === null ? null : parseOrganisationId(raw);
			});
		},

		setOrg(userId, organisationId, generation) {
			if (!isCanonicalUuid(userId)) return refused('the user ID is not a canonical UUID');
			if (!isCanonicalUuid(organisationId)) return refused('the organisation ID is not a canonical UUID');
			if (!isGeneration(generation)) return refused('the generation is not valid');
			const { account, organisation } = generation;
			return enqueue(async () => {
				const current = currentGeneration();
				if (current.account !== account || current.organisation !== organisation) return 'stale' as const;
				await set(organisationKey(userId), organisationId);
				return 'written' as const;
			});
		},

		forgetOrgIf(userId, organisationId) {
			if (!isCanonicalUuid(userId)) return refused('the user ID is not a canonical UUID');
			if (!isCanonicalUuid(organisationId)) return refused('the organisation ID is not a canonical UUID');
			return enqueue(async () => {
				const key = organisationKey(userId);
				const raw = await get(key);
				if (raw === null) return 'absent' as const;
				if (parseOrganisationId(raw) !== organisationId) return 'other-kept' as const;
				await remove(key);
				return 'deleted' as const;
			});
		},

		settled(timeoutMs) {
			if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > longestTimeout)
				return Promise.reject(new RangeError('credential store: the timeout is not a whole number of milliseconds in range'));
			if (outstanding === 0) return Promise.resolve('settled' as const);
			// Only what is queued now: `tail` is replaced by later operations, this reference is not.
			const queued = tail;
			return new Promise<'settled' | 'timed-out'>((resolve) => {
				const timer = setTimeout(() => resolve('timed-out'), timeoutMs);
				void queued.then(() => { clearTimeout(timer); resolve('settled'); });
			});
		}
	};
};
