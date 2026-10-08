import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import { useAccount } from '../account/AccountProvider.tsx';
import { isSignedIn, webCopy } from '../account/copy.ts';
import { createMemberControls } from '../account/member-controls.ts';
import { managesMembers, memberChangeAllowed, type MemberScope, type MembersCalls, type MembersData, type Member } from '../account/members.ts';
import type { Role } from '../account/me.ts';
import { Button } from '../components/AccountPage.tsx';
import { PlainScreen } from '../components/Screen.tsx';
import { space, type } from '../theme/tokens.ts';
import { initials } from '../threads/Presentation.tsx';
import { themedStyles } from '../theme/theme.ts';
import Welcome from './welcome.tsx';

export default function Members() {
 const styles = useStyles();
 const account = useAccount(), view = account.snapshot.account;
 // From the thread list's Team row (bookings contract §3) the way back is to Threads; from Settings, to Settings.
 const fromThreads = useLocalSearchParams<{ from?: string }>().from === 'threads';
 const back = () => router.dismissTo(fromThreads ? '/' : '/settings');
 let content;
 if (view.kind === 'checking' || view.kind === 'starting') content = <Text style={styles.body}>{webCopy.checking}</Text>;
 else if (view.kind === 'unverified') return <Welcome />;
 else if (!isSignedIn(view)) return null;
 else if (view.org.kind !== 'chosen' || view.scope === null) content = <><Text style={styles.body}>Choose an organisation to manage its members.</Text><Button label="Choose organisation" onPress={() => router.push('/organisation')} /></>;
 else if (!managesMembers(view.org.membership.role)) content = <Text testID="members-denied" style={styles.body}>Only owners and admins can manage members and invitations.</Text>;
 else if (Platform.OS !== 'web' || account.web === null) content = <Text style={styles.body}>Member management is available in the browser in this version.</Text>;
 else content = <MembersPanel key={`${view.scope.epoch}:${view.org.membership.role}`} calls={account.web.members} scope={{ ...view.scope, role: view.org.membership.role }} name={view.org.membership.organisationName} now={account.now} />;
 return <PlainScreen title="Members" back={{ label: fromThreads ? 'Threads' : 'Settings', onPress: back }}>{content}</PlainScreen>;
}
function MembersPanel({ calls, scope, name, now }: { calls: MembersCalls; scope: MemberScope; name: string; now: () => number }) {
 const styles = useStyles();
 const [controls] = useState(() => createMemberControls(calls, scope, now));
 const state = useSyncExternalStore(controls.subscribe, controls.snapshot, controls.snapshot);
 const [email, setEmail] = useState(''), [role, setRole] = useState<'admin' | 'member'>('member'), [copy, setCopy] = useState('');
 const [, wake] = useState(0);
 useEffect(() => { void controls.refresh(); return () => controls.dispose(); }, [controls]);
 useEffect(() => setCopy(''), [state.invitation]);
 const delay = Math.max(0, state.waitUntil - now());
 useEffect(() => { if (!delay) return; const timer = setTimeout(() => wake(n => n + 1), Math.min(2_147_483_647, delay)); return () => clearTimeout(timer); }, [delay]);
 const busy = state.phase === 'loading' || state.phase === 'saving';
 const disabled = busy || delay > 0 || state.needsRefresh;
 const actor = state.data?.members.find(row => row.userId === scope.userId);
 const copyLink = async () => {
  const link = state.invitation;
  if (!link) return;
  try { await navigator.clipboard.writeText(link.url); if (controls.snapshot().invitation === link) setCopy('Link copied.'); }
  catch { if (controls.snapshot().invitation === link) setCopy('Could not copy automatically. Select and copy the link below.'); }
 };
 return <View style={styles.stack}>
  <Text style={styles.body}>{name}</Text>
  {state.phase === 'loading' ? <Text testID="members-loading" style={styles.body}>Loading members and invitations…</Text> : null}
  {state.message ? <Text testID="members-status" role={state.phase === 'failed' || state.phase === 'refused' ? 'alert' : 'status'} style={styles.body}>{state.message}</Text> : null}
  {state.phase === 'saving' ? <Text testID="members-saving" role="status" style={styles.body}>Saving your change…</Text> : null}
  {delay > 0 ? <Text testID="members-wait" style={styles.body}>Captain asked you to wait before trying again.</Text> : null}
  <Button testID="members-refresh" label="Refresh members and invitations" disabled={busy || delay > 0} onPress={() => { void controls.refresh(); }} />
  {state.invitation ? <View style={styles.card} testID="members-invitation-link">
   <Text style={styles.body}>For {state.invitation.email}. The link is shown only here; copy it before leaving.</Text>
   <TextInput testID="invitation-link" accessibilityLabel="Invitation link" value={state.invitation.url} editable={false} multiline selectTextOnFocus style={styles.input} />
   <Button label="Copy invitation link" testID="invitation-copy" onPress={() => { void copyLink(); }} />
   {copy ? <Text role="status" testID="invitation-copy-status" style={styles.body}>{copy}</Text> : null}
  </View> : null}
  {state.data ? <>
   <Text role="heading" style={styles.section}>Members</Text>
   {state.data.members.length === 0 ? <Text testID="members-empty" style={styles.body}>No members were returned. Refresh before making changes.</Text> : null}
   {state.data.members.map(member => <MemberRow key={`${member.userId}:${member.role}`} member={member} data={state.data!} scope={scope} disabled={disabled} change={controls.change} />)}
   {actor && managesMembers(actor.role) ? <View style={styles.card}>
    <Text role="heading" style={styles.heading}>Invite someone</Text>
    <Text style={styles.body}>Create a link for their email address. They sign in with Google using that address. Links last seven days and work once. Captain does not send an email.</Text>
    <TextInput testID="invite-email" accessibilityLabel="Email address" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} maxLength={320} editable={!disabled} placeholder="person@example.com" style={styles.input} />
    <RoleChoices label="Invitation role" roles={['member', 'admin']} value={role} disabled={disabled} onChange={value => setRole(value as 'admin' | 'member')} />
    <Button testID="invite-create" label="Create invitation" primary disabled={disabled} onPress={() => { void controls.change({ kind: 'invite', email, role }); }} />
   </View> : null}
   <Text role="heading" style={styles.section}>Pending invitations</Text>
   {state.data.invitations.length === 0 ? <Text testID="invitations-empty" style={styles.body}>No pending invitations.</Text> : null}
   {state.data.invitations.map(invitation => <View style={styles.card} key={invitation.id} testID={`invitation-${invitation.id}`}>
    <Text style={styles.body}>{invitation.email}</Text><Text style={styles.body}>{invitation.role} · Expires {new Date(invitation.expiresAt).toLocaleDateString()}</Text>
    <Button label={`Revoke invitation for ${invitation.email}`} testID={`invitation-revoke-${invitation.id}`} disabled={disabled} onPress={() => { void controls.change({ kind: 'revoke', id: invitation.id }); }} />
   </View>)}
  </> : null}
 </View>;
}
function RoleChoices({ label, roles, value, disabled, onChange }: { label: string; roles: readonly Role[]; value: Role; disabled: boolean; onChange(value: Role): void }) {
 const styles = useStyles();
 return <View style={styles.stack} role="group" aria-label={label}><Text style={styles.body}>{label}: {value}</Text><View style={styles.row}>{roles.map(role => <Button key={role} label={role} disabled={disabled || role === value} onPress={() => onChange(role)} />)}</View></View>;
}
function MemberRow({ member, data, scope, disabled, change }: { member: Member; data: MembersData; scope: MemberScope; disabled: boolean; change: ReturnType<typeof createMemberControls>['change'] }) {
 const styles = useStyles();
 const [role, setRole] = useState<Role>(member.role);
 const actor = data.members.find(row => row.userId === scope.userId);
 const canEdit = actor?.role === 'owner' || (actor?.role === 'admin' && member.role !== 'owner');
 const lastOwner = member.role === 'owner' && data.members.filter(row => row.role === 'owner').length === 1;
 return <View style={styles.card} testID={`member-${member.userId}`}>
  <View style={styles.person}><View aria-hidden style={styles.avatar}><Text style={styles.initials}>{initials(member.name || member.email)}</Text></View>
   <View style={styles.who}><Text style={styles.name}>{member.name || member.email}{member.userId === scope.userId ? ' (you)' : ''}</Text><Text style={styles.detail}>{member.email}</Text></View></View>
  <Text style={styles.body}>Role: {member.role}</Text>
  {lastOwner ? <Text style={styles.body}>The last owner must stay until another owner is appointed.</Text> : null}
  {canEdit ? <>
   <RoleChoices label={`Role for ${member.email}`} roles={actor?.role === 'owner' ? ['owner', 'admin', 'member'] : ['admin', 'member']} value={role} disabled={disabled || lastOwner} onChange={setRole} />
   <Button testID={`member-role-${member.userId}`} label={`Save role for ${member.email}`} disabled={disabled || !memberChangeAllowed(data, scope, { kind: 'role', userId: member.userId, role })} onPress={() => { void change({ kind: 'role', userId: member.userId, role }); }} />
   <Button testID={`member-remove-${member.userId}`} label={`Remove ${member.email}`} disabled={disabled || !memberChangeAllowed(data, scope, { kind: 'remove', userId: member.userId })} onPress={() => { void change({ kind: 'remove', userId: member.userId }); }} />
  </> : <Text style={styles.body}>Only an owner can change an owner.</Text>}
 </View>;
}
/** Prototype frame 12 (Team): spaced-capital section labels, white cards, a 32 pt initials avatar, 13 pt bold names over
 *  11 pt details. The controls are the app's own, in the R3 button style. */
const useStyles = themedStyles((colors) => ({ stack: { gap: 10 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
 card: { gap: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 14 },
 heading: { fontSize: type.body, fontWeight: '700', color: colors.heading },
 section: { fontSize: type.section, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: colors.muted, marginTop: 8 },
 person: { flexDirection: 'row', alignItems: 'center', gap: 10 },
 avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.sage, alignItems: 'center', justifyContent: 'center' },
 initials: { fontSize: 11, fontWeight: '700', color: colors.sageText },
 who: { flex: 1, minWidth: 0 },
 name: { fontSize: type.rowTitle, lineHeight: type.rowTitleLine, fontWeight: '700', color: colors.heading },
 detail: { fontSize: type.rowDetail, lineHeight: type.rowDetailLine, color: colors.muted },
 body: { fontSize: type.small, lineHeight: type.smallLine, color: colors.body },
 input: { minHeight: space.minTarget, padding: 10, borderWidth: 1, borderColor: colors.fieldLine, borderRadius: 8, fontSize: type.body, color: colors.body, backgroundColor: colors.card } }));
