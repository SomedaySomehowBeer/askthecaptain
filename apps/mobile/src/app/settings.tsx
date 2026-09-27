import { router, useNavigation } from 'expo-router';
import { View } from 'react-native';
import { Notice } from '../components/Notice.tsx';
import { PlainScreen } from '../components/Screen.tsx';

/** Account and Settings, opened from the avatar (plan D11: not a fourth tab). This build has no sign-in yet. */
export default function Settings() {
	const navigation = useNavigation();
	const back = () => { if (navigation.canGoBack()) router.back(); else router.replace('/work'); };
	return (
		<PlainScreen title="Account" back={{ label: 'Back', onPress: back }}>
			<View style={{ gap: 12 }}>
				<Notice title="Not signed in">
					Signing in from this app is not available in this build yet. Your organisation, sign-out and account details will appear here once it is.
				</Notice>
				<Notice title="Other settings">
					Organisation creation, invitations, passkeys and other settings stay on the Captain website.
				</Notice>
			</View>
		</PlainScreen>
	);
}
