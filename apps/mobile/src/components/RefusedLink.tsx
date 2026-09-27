import { returnToMyWork } from '../account/tab-entry.ts';
import { Notice } from './Notice.tsx';
import { PlainScreen } from './Screen.tsx';

/** A link this app will not open (contract §5): said in words, with the way on to My work. "Go to My work" always
 *  goes to My work, never back to whatever came before. On iOS and Android it returns to the existing tabs rather than
 *  stacking a second set, or builds them if there are none (docs/plans/expo-mobile-native-navigation-2026-09.md §3.2a,
 *  E11). While signed out nothing happens, as before: the tabs are not allowed yet. */
export function RefusedLink() {
	return (
		<PlainScreen title="This link can’t be opened in Captain" back={{ label: 'Go to My work', onPress: returnToMyWork }}>
			<Notice title="Nothing was opened">
				The link is not one this app can open. Nothing was changed. Open Captain from the app or the website instead.
			</Notice>
		</PlainScreen>
	);
}
