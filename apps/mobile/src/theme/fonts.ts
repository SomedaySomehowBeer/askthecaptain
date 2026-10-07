import { FontDisplay, useFonts } from 'expo-font';
import { faces } from './tokens.ts';

/** The vendored faces (apps/mobile/assets/fonts; SIL Open Font License 1.1, each with its OFL.txt): Fraunces SemiBold
 *  and Inter Regular, SemiBold and Bold, static instances of the Google Fonts sources (see apps/mobile/README.md
 *  "Fonts"). On the web they swap in when loaded, so text shows at once in the fallback; on iOS and Android the root
 *  waits for them (local files, a few milliseconds) so no text is drawn with an unregistered family. */
const sources = {
	[faces.display]: { uri: require('../../assets/fonts/fraunces/Fraunces-SemiBold.ttf'), display: FontDisplay.SWAP },
	[faces.regular]: { uri: require('../../assets/fonts/inter/Inter-Regular.ttf'), display: FontDisplay.SWAP },
	[faces.semibold]: { uri: require('../../assets/fonts/inter/Inter-SemiBold.ttf'), display: FontDisplay.SWAP },
	[faces.bold]: { uri: require('../../assets/fonts/inter/Inter-Bold.ttf'), display: FontDisplay.SWAP }
};

/** True once the faces are registered, or once loading failed (the system fonts then stay). */
export function useCaptainFonts(): boolean {
	const [loaded, error] = useFonts(sources);
	return loaded || error !== null;
}
