import type { ReadScope } from './contracts.ts';

/** Whether a list bound to `bound` (the ready scope its screen first rendered with) is inert under `current`, the scope
 *  rendered now. `RootStack` returns to the thread list in an effect, after the new account has rendered once, so for that
 *  render the old screen sees a new scope while still holding the old rows. An inert screen shows no rows or controls,
 *  starts no read, and applies no answer, until its screen remounts under the new scope. It never becomes live again:
 *  epochs never repeat. */
export const scopeInert = (bound: ReadScope | null, current: ReadScope | null): boolean =>
	bound === null || current === null || current.epoch !== bound.epoch
	|| current.userId !== bound.userId || current.organisationId !== bound.organisationId;

