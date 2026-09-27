import { linkTarget } from '../lib/links.ts';

/** Every incoming system link passes through this before routing (contract §5, Q5). It runs outside the app's state,
 *  so it only allows this shell's own routes. It sends every sign-in callback, and anything else, to the refusal page. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
	return linkTarget(path);
}
