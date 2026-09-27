import { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { formatAbout, moreTags, nextWake, workCopy, workProblemText } from '../../../account/copy.ts';
import { useAccount } from '../../../account/AccountProvider.tsx';
import { Button } from '../../../components/AccountPage.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { Screen } from '../../../components/Screen.tsx';
import { colors, space, type } from '../../../theme/tokens.ts';
import { blockedReason, capReached, moreAvailable, retryOp } from '../../../work/my-work-list.ts';
import { formatDue, type WorkRow } from '../../../work/my-work.ts';
import { useMyWork } from '../../../work/useMyWork.ts';

/** Work → My work, the default view: the person's own open tasks in the chosen organisation, read-only
 *  (docs/plans/expo-mobile-my-work-read-2026-09.md §3.5). The fixed subtitle says exactly which filter this is. Rows
 *  are plain text: no press handler, link role or focus as a control. */
export default function MyWork() {
	const { list, inert, now, request } = useMyWork();
	const { webLink } = useAccount();
	useWaitWake(list.problem?.wait ?? null, now);
	// The account moved to another scope and the tabs are about to reset: show nothing of the old list, offer nothing.
	if (inert) {
		return (
			<Screen section="work" title={workCopy.heading}>
				<Text testID="work-subtitle" style={styles.subtitle}>{workCopy.subtitle}</Text>
			</Screen>
		);
	}

	const blocked = blockedReason(list, now());
	const reason = blocked === 'loading' ? workCopy.busy
		: blocked === 'waiting' && list.problem?.wait ? `Try again after about ${formatAbout(list.problem.wait.about)}` : null;
	const retry = retryOp(list);
	const problem = list.problem;
	const tryAgain = retry === null ? null : (
		<Button testID="work-try-again" label={workCopy.tryAgain} disabled={blocked !== null} reason={reason} onPress={() => request(retry)} />
	);
	const webWork = webLink('/work');

	return (
		<Screen section="work" title={workCopy.heading}>
			<Text testID="work-subtitle" style={styles.subtitle}>{workCopy.subtitle}</Text>
			{!list.loaded ? (
				problem === null ? <Text testID="work-loading" style={styles.body}>{workCopy.loading}</Text> : (
					<View style={styles.stack}>
						<Notice title={workCopy.heading}>{workProblemText(problem)}</Notice>
						{tryAgain}
					</View>
				)
			) : (
				<View style={styles.stack}>
					<Button testID="work-refresh" label={workCopy.refresh} disabled={blocked !== null} reason={reason} onPress={() => request('refresh')} />
					{problem !== null ? <View style={styles.stack}><Notice title={workCopy.heading}>{workProblemText(problem)}</Notice>{tryAgain}</View> : null}
					{list.rows.length === 0 ? <Notice title={workCopy.emptyTitle}>{workCopy.emptyBody}</Notice> : (
						<View role="list" style={styles.list}>
							{list.rows.map((row) => <Row key={row.id} row={row} />)}
						</View>
					)}
					{moreAvailable(list) ? <Button testID="work-more" label={workCopy.more} disabled={blocked !== null} reason={reason} onPress={() => request('more')} /> : null}
					{capReached(list) ? (
						<View testID="work-cap" style={styles.stack}>
							<Text style={styles.body}>{workCopy.capNotice}</Text>
							{webWork === null ? null : <Button testID="work-web" label={workCopy.openWebWork} onPress={() => { void Linking.openURL(webWork); }} />}
						</View>
					) : null}
				</View>
			)}
		</Screen>
	);
}

function Row({ row }: { row: WorkRow }) {
	const extra = moreTags(row.tagCount, row.tags.length);
	const tags = [...row.tags.map((tag) => tag.name), ...(extra === null ? [] : [extra])];
	const due = formatDue(row.due);
	const label = [row.displayTitle, workCopy.open, ...tags, due].join(', ');
	return (
		<View role="listitem" accessible aria-label={label} testID={`work-row-${row.id}`} style={styles.row}>
			<Text style={styles.title}>{row.displayTitle}</Text>
			<Text style={styles.detail}>{[workCopy.open, ...tags].join(' · ')}</Text>
			<Text style={styles.detail}>{due}</Text>
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
