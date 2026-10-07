import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import { accountCopy, passkeyDetail } from '../account/copy.ts';
import { createPasskeyControls } from '../account/passkey-controls.ts';
import type { WebCalls } from '../account/web-calls.ts';
import { space, type } from '../theme/tokens.ts';
import { themedStyles } from '../theme/theme.ts';
import { Button } from './AccountPage.tsx';

export function Passkeys({ web, now }: { web: WebCalls | null; now: () => number }) {
 const styles = useStyles();
 return <View testID="account-passkeys" style={styles.stack}>
  <Text role="heading" style={styles.heading}>{accountCopy.passkeys}</Text>
  <Text style={styles.muted}>{accountCopy.passkeysIntro} Once you add one, every sign-in asks for it.</Text>
  {web === null || Platform.OS !== 'web' ? <Text style={styles.muted}>{accountCopy.passkeysNative}</Text> : <WebPasskeys web={web} now={now} />}
 </View>;
}
function WebPasskeys({ web, now }: { web: WebCalls; now: () => number }) {
 const styles = useStyles();
 const [controls] = useState(() => createPasskeyControls(web, now));
 const state = useSyncExternalStore(controls.subscribe, controls.snapshot, controls.snapshot);
 const [name, setName] = useState('');
 const [, wake] = useState(0);
 const [supported, setSupported] = useState<boolean | null>(null);
 useEffect(() => {
  setSupported(typeof window !== 'undefined' && window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined');
  void controls.refresh();
  return () => controls.dispose();
 }, [controls]);
 const delay = Math.max(0, state.waitUntil - now());
 const waiting = delay > 0;
 useEffect(() => { if (!waiting) return; const timer = setTimeout(() => wake(n => n + 1), Math.min(2_147_483_647, Math.max(1, delay))); return () => clearTimeout(timer); }, [delay, waiting]);
 const busy = ['loading', 'adding', 'removing'].includes(state.phase);
 const disabled = busy || waiting || state.mustRefresh;
 const add = async () => {
  if (!supported) return;
  await controls.add(name, async options => {
   const { startRegistration } = await import('@simplewebauthn/browser');
   return startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON });
  });
 };
 return <View style={styles.stack}>
  {state.phase === 'loading' ? <Text testID="account-passkeys-loading" style={styles.muted}>{accountCopy.passkeysLoading}</Text> : null}
  {state.phase === 'failed' ? <Text testID="account-passkeys-failed" role="alert" style={styles.body}>{state.message}</Text> : null}
  {state.phase !== 'failed' && state.message ? <Text testID="passkey-status" role="status" style={styles.body}>{state.message}</Text> : null}
  {waiting ? <Text testID="passkey-wait" style={styles.muted}>Captain asked you to wait before trying again.</Text> : null}
  {state.list && !state.list.available ? <Text testID="account-passkeys-unavailable" style={styles.body}>{accountCopy.passkeysUnavailable}</Text> : null}
  {state.list?.available && state.list.passkeys.length === 0 ? <Text testID="account-passkeys-none" style={styles.body}>{accountCopy.passkeysNone}</Text> : null}
  {state.list?.available ? <>
   <View role="list" style={styles.stack}>{state.list.passkeys.map(passkey => <View key={passkey.id} role="listitem" testID={`account-passkey-${passkey.id}`} style={styles.card}>
    <Text style={styles.name}>{passkey.name}</Text><Text style={styles.muted}>{passkeyDetail(passkey)}</Text>
    <Button testID={`passkey-remove-${passkey.id}`} label={`Remove ${passkey.name}`} disabled={disabled} onPress={() => { void controls.remove(passkey.id); }} />
   </View>)}</View>
   {supported === null ? <Text style={styles.muted}>Checking this browser’s passkey support…</Text> : !supported ? <Text testID="passkey-unsupported" style={styles.body}>This browser cannot create passkeys, or Captain is not open at its HTTPS address.</Text> : <>
    <Text nativeID="passkey-name-label" style={styles.body}>Passkey name (optional)</Text>
    <TextInput testID="passkey-name" accessibilityLabel="Passkey name (optional)" aria-labelledby="passkey-name-label" value={name} onChangeText={setName} maxLength={60} editable={!disabled} style={styles.input} placeholder="My phone" />
    <Button testID="passkey-add" label="Add a passkey" primary disabled={disabled} onPress={() => { void add(); }} />
   </>}
  </> : null}
  {state.phase === 'adding' ? <Text testID="passkey-busy" role="status" style={styles.muted}>Complete the passkey prompt in your browser. Waiting for Captain to confirm…</Text> : null}
  {state.phase === 'removing' ? <Text testID="passkey-busy" role="status" style={styles.muted}>Removing the passkey…</Text> : null}
  <Button testID={state.phase === 'failed' ? 'account-passkeys-try-again' : 'passkey-refresh'} label={state.phase === 'failed' ? 'Try again' : 'Refresh passkeys'} disabled={busy || waiting} onPress={() => { void controls.refresh(); }} />
 </View>;
}
const useStyles = themedStyles((colors) => ({
 stack: { gap: 10 }, heading: { fontSize: type.section, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: colors.muted, marginTop: 8 },
 card: { gap: 6, padding: 12, borderRadius: 14, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
 name: { fontSize: type.rowTitle, lineHeight: type.rowTitleLine, fontWeight: '700', color: colors.heading },
 body: { fontSize: type.small, lineHeight: type.smallLine, color: colors.body }, muted: { fontSize: type.small, lineHeight: type.smallLine, color: colors.muted },
 input: { minHeight: space.minTarget, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.fieldLine, borderRadius: 10, backgroundColor: colors.card, color: colors.heading, fontSize: type.body }
}));
