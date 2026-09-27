import { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { formatAbout, nextWake, workViewCopy, workViewProblemText } from '../account/copy.ts';
import { useAccount } from '../account/AccountProvider.tsx';
import type { WorkView } from '../api/paths.ts';
import { Button } from '../components/AccountPage.tsx';
import { Notice } from '../components/Notice.tsx';
import { Screen } from '../components/Screen.tsx';
import { colors, space, type } from '../theme/tokens.ts';
import { blockedReason, capReached, moreAvailable, retryOp } from './my-work-list.ts';
import { formatDue, type WorkRow } from './my-work.ts';
import { useWorkList } from './useWorkList.ts';
import { capLink, rowDetail, rowLabel, testIdPrefix } from './work-view.ts';

/** One Work list screen, My work or All tasks, read-only (docs/plans/expo-mobile-my-work-read-2026-09.md §3.5;
 *  docs/plans/expo-mobile-all-tasks-read-2026-09.md §4.3, §5).
 *
 *  **One bound view.** `view` is captured once, on the first render, as `boundView`, and the prop is never read again.
 *  Everything below derives from `boundView` only: the list's reads, paths and parses (`useWorkList(boundView)`), the
 *  wording (one `workViewCopy(boundView)` object), whether owners are shown, each row's detail line and accessibility
 *  label, the cap link and the test IDs. A later prop change is simply ignored, so rows read for one view can never be
 *  shown under another view's heading, owner display or link. The routes pass constants, so it never actually changes.
 *
 *  The fixed subtitle says exactly which filter this is. Rows are plain text: no press handler, link role or focus as a
 *  control. */
export function WorkListScreen({ view }: { view: WorkView }) {
	const [boundView] = useState<WorkView>(view);
	const copy = workViewCopy(boundView);
	const id = testIdPrefix(boundView);
	const { list, inert, now, request } = useWorkList(boundView);
	const { webLink } = useAccount();
	useWaitWake(list.problem?.wait ?? null, now);
	// The account moved to another scope and the tabs are about to reset: show nothing of the old list, offer nothing.
	if (inert) {
		return (
			<Screen section="work" title={copy.heading}>
				<Text testID={`${id}-subtitle`} style={styles.subtitle}>{copy.subtitle}</Text>
			</Screen>
		);
	}

	const blocked = blockedReason(list, now());
	const reason = blocked === 'loading' ? copy.busy
		: blocked === 'waiting' && list.problem?.wait ? `Try again after about ${formatAbout(list.problem.wait.about)}` : null;
	const retry = retryOp(list);
	const problem = list.problem;
	const tryAgain = retry === null ? null : (
		<Button testID={`${id}-try-again`} label={copy.tryAgain} disabled={blocked !== null} reason={reason} onPress={() => request(retry)} />
	);
	const web = webLink(capLink(boundView));

	return (
		<Screen section="work" title={copy.heading}>
			<Text testID={`${id}-subtitle`} style={styles.subtitle}>{copy.subtitle}</Text>
			{!list.loaded ? (
				problem === null ? <Text testID={`${id}-loading`} style={styles.body}>{copy.loading}</Text> : (
					<View style={styles.stack}>
						<Notice title={copy.heading}>{workViewProblemText(copy, problem)}</Notice>
						{tryAgain}
					</View>
				)
			) : (
				<View style={styles.stack}>
					<Button testID={`${id}-refresh`} label={copy.refresh} disabled={blocked !== null} reason={reason} onPress={() => request('refresh')} />
					{problem !== null ? <View style={styles.stack}><Notice title={copy.heading}>{workViewProblemText(copy, problem)}</Notice>{tryAgain}</View> : null}
					{list.rows.length === 0 ? <Notice title={copy.emptyTitle}>{copy.emptyBody}</Notice> : (
						<View role="list" style={styles.list}>
							{list.rows.map((row) => <Row key={row.id} row={row} view={boundView} id={id} />)}
						</View>
					)}
					{moreAvailable(list) ? <Button testID={`${id}-more`} label={copy.more} disabled={blocked !== null} reason={reason} onPress={() => request('more')} /> : null}
					{capReached(list) ? (
						<View testID={`${id}-cap`} style={styles.stack}>
							<Text style={styles.body}>{copy.capNotice}</Text>
							{web === null ? null : <Button testID={`${id}-web`} label={copy.openWebWork} onPress={() => { void Linking.openURL(web); }} />}
						</View>
					) : null}
				</View>
			)}
		</Screen>
	);
}

function Row({ row, view, id }: { row: WorkRow; view: WorkView; id: string }) {
	return (
		<View role="listitem" accessible aria-label={rowLabel(row, view)} testID={`${id}-row-${row.id}`} style={styles.row}>
			<Text style={styles.title}>{row.displayTitle}</Text>
			<Text style={styles.detail}>{rowDetail(row, view)}</Text>
			<Text style={styles.detail}>{formatDue(row.due)}</Text>
		</View>
	);
}

/** Re-renders when this screen's own server wait ends, so its disabled controls become enabled. Sends nothing. */
function useWaitWake(wait: { readonly until: number; readonly about: string } | null, now: () => number) {
	const [, setTick] = useState(0);
	const delay = nextWake([wait], now());
	useEffect(() => {
		if (delay === null) return undefined;
		const timer = setTimeout(() => setTick((n) => n + 1), delay);
		return () => clearTimeout(timer);
	}, [delay, wait]);
}

const styles = StyleSheet.create({
	subtitle: { fontSize: type.body, color: colors.muted, marginTop: -8, marginBottom: 14 },
	body: { fontSize: type.body, lineHeight: 21, color: colors.body },
	stack: { gap: 12 },
	list: { gap: 8 },
	row: { minHeight: space.rowMinHeight, borderRadius: 14, borderWidth: 1, borderColor: colors.rowLine, backgroundColor: colors.card, padding: space.rowPadding, gap: 2 },
	title: { fontSize: type.body, fontWeight: '600', color: colors.heading },
	detail: { fontSize: 13, color: colors.muted }
});
