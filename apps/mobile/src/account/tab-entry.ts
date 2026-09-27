import { router } from 'expo-router';
import { anchored } from '../components/SectionStack.tsx';
import { tabEntryAction, type TabEntry } from './copy.ts';

/** Makes the router call `tabEntryAction` chose for an app-initiated tab entry (docs/plans/expo-mobile-native-
 *  navigation-2026-09.md §3.2a). Every such entry goes through here, so no call site picks its own method or options. */
export function enterTabs(entry: TabEntry): void {
	const call = tabEntryAction(anchored, entry);
	if (call.method === 'dismissTo') router.dismissTo(call.href as never, call.options);
	else router.replace(call.href as never, call.options);
}

/** "Go to My work", and a Back with nowhere to go back: always My work, never whatever page came before. */
export const returnToMyWork = (): void => enterTabs({ intent: 'return-to-my-work' });
