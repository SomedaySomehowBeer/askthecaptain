import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useAccount } from '../../account/AccountProvider.tsx';
import { isSignedIn, webCopy } from '../../account/copy.ts';
import type { ReadScope } from '../../account/contracts.ts';
import type { PushCalls } from '../../account/push.ts';
import { createPushControls } from '../../account/push-controls.ts';
import { browserPush } from '../../platform/push-browser.ts';
import { Button } from '../../components/AccountPage.tsx';
import { PlainScreen } from '../../components/Screen.tsx';
import { colors } from '../../theme/tokens.ts';
import Welcome from '../welcome.tsx';
export default function Notifications() {
 const account = useAccount(), view = account.snapshot.account;
 let content;
 if (view.kind === 'checking' || view.kind === 'starting') content = <Text>{webCopy.checking}</Text>;
 else if (view.kind === 'unverified') return <Welcome />;
 else if (!isSignedIn(view)) return null;
 else if (Platform.OS !== 'web' || !account.web) content = <Text style={styles.body}>Push notification controls are available in the browser. Native push is not available yet.</Text>;
 else if (!view.scope || view.org.kind !== 'chosen') content = <><Text style={styles.body}>Choose an organisation to manage notifications.</Text><Button label="Choose organisation" onPress={() => router.push('/organisation')} /></>;
 else content = <Devices key={view.scope.epoch} calls={account.web.push} scope={view.scope} name={view.org.membership.organisationName} now={account.now} />;
 return <PlainScreen title="Notifications" back={{ label: 'Settings', onPress: () => router.dismissTo('/settings') }}>{content}</PlainScreen>;
}
function Devices({ calls, scope, name, now }: { calls: PushCalls; scope: ReadScope; name: string; now(): number }) {
 const [controls] = useState(() => createPushControls(calls, scope, browserPush, now));
 const state = useSyncExternalStore(controls.subscribe, controls.snapshot, controls.snapshot);
 const [, wake] = useState(0);
 useEffect(() => { void controls.refresh(); return () => controls.dispose(); }, [controls]);
 const delay = Math.max(0, state.waitUntil - now());
 useEffect(() => { if (!delay) return; const timer = setTimeout(() => wake(n => n + 1), Math.min(delay, 2_147_483_647)); return () => clearTimeout(timer); }, [delay]);
 const busy = state.phase === 'loading' || state.phase === 'saving', disabled = busy || delay > 0 || state.needsRefresh;
 const support = browserPush.support();
 const supportText = { ready: 'Register this browser to receive notifications for your account here.', unsupported: 'This browser cannot receive pushes. On iPhone, add Captain to the Home Screen from Safari and open it there.', insecure: 'Notifications need a secure connection. Open Captain at its HTTPS address.', denied: 'Notifications are blocked. Allow Captain in this browser’s site settings, then refresh.' };
 return <View style={styles.stack}>
  <Text style={styles.body}>{name}</Text><Text style={styles.body}>Your devices only. Removing a device here stops its notifications for this organisation.</Text>
  {state.phase === 'loading' ? <Text testID="push-loading" style={styles.body}>Loading notification devices…</Text> : null}
  {state.phase === 'saving' ? <Text testID="push-saving" role="status" style={styles.body}>Working on your request…</Text> : null}
  {state.message ? <Text testID="push-status" role="status" style={styles.body}>{state.message}</Text> : null}
  {delay > 0 ? <Text style={styles.body}>Captain asked you to wait before trying again.</Text> : null}
  <Button testID="push-refresh" label="Refresh devices" disabled={busy || delay > 0} onPress={() => { void controls.refresh(); }} />
  {state.data ? <>
   {!state.data.config.configured ? <Text testID="push-unavailable" style={styles.body}>Push notifications are not set up on this Captain. Ask an admin to check the configuration.</Text> : null}
   <Text testID="push-support" style={styles.body}>{supportText[support]}</Text>
   <Button testID="push-register" label="Register this browser" disabled={disabled || !state.data.config.configured || support !== 'ready'} onPress={() => { void controls.register(); }} />
   {state.data.devices.length === 0 ? <Text testID="push-empty" style={styles.body}>No notification devices registered for you in this organisation.</Text> : null}
   {state.data.devices.map((device, i) => <View key={device.id} testID={`push-device-${device.id}`} style={styles.card}>
    <Text style={styles.body}>Device {i + 1}</Text><Text style={styles.body}>{device.userAgent || 'Browser details unavailable'}</Text>
    <Text style={styles.body}>Registered {new Date(device.createdAt).toLocaleDateString()}. {device.lastUsedAt ? `Last accepted by push service ${new Date(device.lastUsedAt).toLocaleString()}.` : 'No successful push recorded.'}</Text>
    <Button testID={`push-remove-${device.id}`} label={`Remove device ${i + 1}`} disabled={disabled} onPress={() => { void controls.remove(device.endpoint); }} />
   </View>)}
   <View style={styles.card}><Text role="heading" style={styles.body}>Test notification</Text>
    <Text style={styles.body}>To all your registered devices in this organisation:</Text><Text style={styles.body}>Captain can reach this device</Text><Text style={styles.body}>Briefs and reminders will arrive like this.</Text>
    <Button testID="push-test" label="Send this test notification" disabled={disabled || !state.data.config.configured || !state.data.devices.length} onPress={() => { void controls.test(); }} />
   </View>
  </> : null}
 </View>;
}
const styles = StyleSheet.create({ stack: { gap: 12 }, body: { color: colors.body, fontSize: 15, lineHeight: 21 }, card: { gap: 10, backgroundColor: colors.card, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 14 } });
