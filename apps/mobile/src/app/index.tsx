import { Redirect, router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAccount } from '../account/AccountProvider.tsx';
import { isSignedIn, threadsCopy, webCopy } from '../account/copy.ts';
import { Calendar, ChevronRight, People } from '../components/Icons.tsx';
import { Notice } from '../components/Notice.tsx';
import { PlainScreen, Screen } from '../components/Screen.tsx';
import { colors, space, type } from '../theme/tokens.ts';

/** `/`: the one list of threads (docs/proposals/2026-09-29-chat-first-captain.md "Navigation"), empty in this
 *  increment: the header, the filter row, the pinned rows and an honest empty state; no data read yet. While the
 *  account is still being checked it says so; otherwise, when the account does not allow the list, it redirects to
 *  where it does (welcome, or the organisation chooser), so `/` never shows the list before the guards allow it. */
export default function Home() {
	const { snapshot } = useAccount();
	const account = snapshot.account;
	if (account.kind === 'checking' || account.kind === 'starting') {
		return <PlainScreen title="Captain" back={null}><Text testID="shell-checking" style={styles.body}>{webCopy.checking}</Text></PlainScreen>;
	}
	if (!isSignedIn(account)) return <Redirect href="/welcome" />;
	if (account.org.kind !== 'chosen') return <Redirect href="/organisation" />;
	return (
		<Screen title={threadsCopy.heading}>
			<View role="radiogroup" aria-label={threadsCopy.filterGroup} style={styles.filters}>
				{threadsCopy.filters.map((filter, index) => (
					<Pressable key={filter} testID={`threads-filter-${index}`} role="radio" aria-checked={index === 0} aria-label={filter}
						style={[styles.filter, index === 0 && styles.filterOn]}>
						<Text style={[styles.filterText, index === 0 && styles.filterTextOn]}>{filter}</Text>
					</Pressable>
				))}
			</View>
			<View style={styles.pinned}>
				<PinnedRow testID="threads-pinned-equipment" label={threadsCopy.pinnedEquipment} detail={threadsCopy.pinnedEquipmentDetail}
					icon={<Calendar color={colors.sageText} />} onPress={() => router.push('/equipment')} />
				<PinnedRow testID="threads-pinned-team" label={threadsCopy.pinnedTeam} detail={threadsCopy.pinnedTeamDetail} icon={<People color={colors.muted} />} last />
			</View>
			<View testID="threads-empty"><Notice title={threadsCopy.emptyTitle}>{threadsCopy.emptyBody}</Notice></View>
		</Screen>
	);
}

/** A pinned row opens a view that is not a list of threads. One without `onPress` is listed but not available. */
function PinnedRow({ testID, label, detail, icon, onPress, last = false }: { testID: string; label: string; detail: string; icon: React.ReactNode; onPress?: () => void; last?: boolean }) {
	const content = (
		<>
			<View style={styles.icon}>{icon}</View>
			<View style={styles.text}>
				<Text style={[styles.label, onPress ? null : styles.unavailable]}>{label}</Text>
				<Text style={styles.detail}>{detail}</Text>
			</View>
			{onPress ? <ChevronRight color={colors.muted} /> : null}
		</>
	);
	const style = [styles.row, last ? styles.lastRow : null];
	if (!onPress) return <View testID={testID} style={style} accessible aria-label={`${label}. ${detail}`} aria-disabled>{content}</View>;
	return <Pressable testID={testID} style={style} onPress={onPress} role="link" aria-label={`${label}. ${detail}`}>{content}</Pressable>;
}

const styles = StyleSheet.create({
	body: { fontSize: type.body, lineHeight: 21, color: colors.body },
	filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 },
	filter: { minHeight: space.minTarget, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
	filterOn: { backgroundColor: colors.sage, borderColor: colors.sage },
	filterText: { fontSize: 14, color: colors.body },
	filterTextOn: { fontWeight: '600', color: colors.sageText },
	pinned: { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.line, overflow: 'hidden', marginBottom: 14 },
	row: { minHeight: space.rowMinHeight, padding: space.rowPadding, flexDirection: 'row', gap: 12, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.rowLine },
	lastRow: { borderBottomWidth: 0 },
	icon: { width: 32, height: 32, borderRadius: 11, backgroundColor: colors.sage, alignItems: 'center', justifyContent: 'center' },
	text: { flex: 1, minWidth: 0 },
	label: { fontSize: type.rowTitle, fontWeight: '600', color: colors.heading },
	unavailable: { color: colors.muted },
	detail: { marginTop: 2, fontSize: type.rowDetail, lineHeight: type.rowDetailLine, color: colors.muted }
});
