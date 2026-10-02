import { useEffect, useState, useSyncExternalStore } from 'react';
import * as Crypto from 'expo-crypto';
import { createSaver, type SaveCopy, type Saver } from './saver.ts';

export type CardHooks = {
	now(): number;
	/** After a confirmed write: reload the record and reconcile the thread (its change line arrives by the change feed). */
	saved(): void;
	/** After a stale revision or a discard. */
	reload(): void;
	lost(): void;
};
/** A saver for one kind of card write, alive for the screen; its state as React state. */
export function useSaver<T>(hooks: CardHooks, copy: SaveCopy, onSaved?: (value: T | null) => void): [Saver<T>, ReturnType<Saver<T>['snapshot']>] {
	const [saver] = useState(() => createSaver<T>({ now: hooks.now, randomId: () => Crypto.randomUUID(), copy,
		saved: (value) => { onSaved?.(value); hooks.saved(); }, reload: () => hooks.reload(), lost: () => hooks.lost() }));
	useEffect(() => () => saver.dispose(), [saver]);
	const state = useSyncExternalStore(saver.subscribe, saver.snapshot, saver.snapshot);
	return [saver, state];
}
