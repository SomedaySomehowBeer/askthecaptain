import { router } from 'expo-router';
import { Notice } from './Notice.tsx';
import { PlainScreen } from './Screen.tsx';

/** A link this app will not open (contract §5): said in words, with the way on to My work. */
export function RefusedLink() {
	return (
		<PlainScreen title="This link can’t be opened in Captain" back={{ label: 'Go to My work', onPress: () => router.replace('/work') }}>
			<Notice title="Nothing was opened">
				The link is not one this app can open. Nothing was changed. Open Captain from the app or the website instead.
			</Notice>
		</PlainScreen>
	);
}
