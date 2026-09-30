import { router } from 'expo-router';
import { refusedCopy } from '../account/copy.ts';
import { Notice } from './Notice.tsx';
import { PlainScreen } from './Screen.tsx';

/** A link this app will not open (contract §5): said in words, with the way on to the thread list. "Go to threads"
 *  always goes to the thread list, never back to whatever came before: it pops to the list when it is beneath, or opens
 *  it. While signed out the list redirects to welcome, as ever. */
export function RefusedLink() {
	return (
		<PlainScreen title={refusedCopy.heading} back={{ label: refusedCopy.back, onPress: () => router.dismissTo('/') }}>
			<Notice title={refusedCopy.title}>{refusedCopy.body}</Notice>
		</PlainScreen>
	);
}
