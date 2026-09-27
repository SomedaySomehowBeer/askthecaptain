import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { TabBar } from '../../components/TabBar.tsx';

/** Exactly three tabs, Work, Chat and Resources (plan D11), each with its own stack.
 *
 *  On the web, tab history only grows (`fullHistory`): each tab change is a new browser-history entry. With the
 *  default `firstRoute`, returning to Work shortens the tab history. React Navigation's web linking reads that as going
 *  back and calls `history.go(-n)` into whatever entry it finds, which consumed and overwrote unrelated entries and,
 *  after a browser back, went past the app's first entry to a blank page. iOS and Android keep the platform-standard
 *  `firstRoute`: back returns to Work, then leaves the app. */
export default function TabsLayout() {
	return (
		<Tabs tabBar={(props) => <TabBar {...props} />} backBehavior={Platform.OS === 'web' ? 'fullHistory' : 'firstRoute'} screenOptions={{ headerShown: false }}>
			<Tabs.Screen name="work" options={{ title: 'Work' }} />
			<Tabs.Screen name="chat" options={{ title: 'Chat' }} />
			<Tabs.Screen name="resources" options={{ title: 'Resources' }} />
		</Tabs>
	);
}
