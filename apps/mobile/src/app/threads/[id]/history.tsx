/** `/threads/[id]/history` (versions contract §6; design boards 5–11): the thread's record history, selection, the
 *  preview sheet and the apply. The back link names the record and returns to its thread. `?changeSet=` (from a change
 *  line) brings that change set into view. */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useAccount } from '../../../account/AccountProvider.tsx';
import type { ReadScope } from '../../../account/contracts.ts';
import { isSignedIn, webCopy } from '../../../account/copy.ts';
import { isCanonicalUuid } from '../../../api/paths.ts';
import { Screen } from '../../../components/Screen.tsx';
import type { ThreadCalls } from '../../../threads/api.ts';
import { copy } from '../../../threads/copy.ts';
import { createHistory } from '../../../threads/history/controller.ts';
import { historyCopy } from '../../../threads/history/copy.ts';
import { HistoryList, TickBar } from '../../../threads/history/HistoryView.tsx';
import { PreviewSheet } from '../../../threads/history/PreviewSheet.tsx';
import { browserPendingUndo } from '../../../threads/history/storage.ts';
import type { HistoryWords } from '../../../threads/history/words.ts';
import { useTheme } from '../../../theme/theme.ts';
import { useDeadline } from '../../../threads/use-poll.ts';
import Welcome from '../../welcome.tsx';

export default function HistoryScreen() {
	const { colors } = useTheme();
	const account = useAccount(), view = account.snapshot.account;
	const params = useLocalSearchParams<{ id: string; changeSet?: string }>();
	const id = params.id;
	const back = { label: 'Thread', onPress: () => router.dismissTo(isCanonicalUuid(id) ? `/threads/${id}` : '/') };
	if (view.kind === 'checking' || view.kind === 'starting') return <Screen back={back}><Text style={{ color: colors.plain }}>{webCopy.checking}</Text></Screen>;
	if (view.kind === 'unverified') return <Welcome />;
	if (!isSignedIn(view)) return null;
	if (!isCanonicalUuid(id)) return <Screen back={back}><Text style={{ color: colors.plain }}>{copy.lost}</Text></Screen>;
	if (!account.web || !view.scope || view.org.kind !== 'chosen') return <Screen back={back}><Text style={{ color: colors.plain }}>{historyCopy.unavailable}</Text></Screen>;
	const focus = typeof params.changeSet === 'string' && isCanonicalUuid(params.changeSet) ? params.changeSet : null;
	return <History key={`${view.scope.epoch}:${id}`} calls={account.web.threads} scope={view.scope} id={id} focus={focus} now={account.now} />;
}

function History({ calls, scope, id, focus, now }: { calls: ThreadCalls; scope: ReadScope; id: string; focus: string | null; now: () => number }) {
	const { colors } = useTheme();
	const [controller] = useState(() => createHistory({ calls, scope, threadId: id, now, randomId: () => Crypto.randomUUID(), storage: browserPendingUndo }));
	useEffect(() => { void controller.load(); return () => controller.dispose(); }, [controller]);
	const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
	const waiting = useDeadline(state.sheet?.waitUntil ?? 0, now);
	const title = state.detail?.card.title ?? 'Thread';
	const back = { label: title, onPress: () => router.dismissTo(`/threads/${id}`) };
	const fold = state.detail?.card.fold;
	// Wall-clock time for "today"; the organisation's zone for every time shown.
	const words: HistoryWords = { now: Date.now(), zone: state.zone ?? undefined, unit: typeof fold?.unitLabel === 'string' ? fold.unitLabel : null,
		equipmentName: typeof fold?.equipmentName === 'string' ? fold.equipmentName : null };
	if (state.phase === 'lost') return <Screen back={{ label: 'Threads', onPress: () => router.dismissTo('/') }}><Text testID="history-lost" role="status" style={{ color: colors.body }}>{copy.lost}</Text></Screen>;
	return <Screen back={back} list={(frame) => <View style={{ flex: 1 }}>
		<HistoryList state={state} controller={controller} words={words} focus={focus} contentStyle={frame.contentContainerStyle}
			heading={<>{<Text role="heading" testID="history-heading" style={{ fontSize: 26, fontWeight: '600', color: colors.heading, marginBottom: 2 }}>{historyCopy.heading}</Text>}{frame.heading}</>} />
		<TickBar state={state} controller={controller} />
		<PreviewSheet state={state} controller={controller} words={words} waiting={waiting}
			onSchedule={() => { controller.closeSheet(); router.push('/equipment'); }}
			onSetYourself={() => { controller.closeSheet(); router.dismissTo({ pathname: '/threads/[id]', params: { id, edit: String(Date.now()) } }); }} />
	</View>} />;
}
