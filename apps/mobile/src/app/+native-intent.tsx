import { systemLinkTarget } from '../lib/links.ts';

/** Every incoming system link passes through this before routing (contract §5, Q5). It runs outside the app's state,
 *  so it only allows this shell's own routes. An exact sign-in callback answers null: expo-router then does not
 *  navigate, and only the pending authentication session (the attempt core) ever reads it. Every other link, including
 *  other `/auth/*` paths and callback lookalikes, goes to the refusal page. Nothing is logged. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
	return systemLinkTarget(path);
}
