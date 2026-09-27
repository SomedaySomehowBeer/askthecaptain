import { useEffect, useState } from 'react';
import { Linking, SectionList, StyleSheet, Text, View } from 'react-native';
import { useAccount } from '../../../account/AccountProvider.tsx';
import { formatAbout, nextWake, stockCopy, stockCountText, stockProblemText, stockReorderText, stockRowLabel } from '../../../account/copy.ts';
import { Button } from '../../../components/AccountPage.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { Screen } from '../../../components/Screen.tsx';
import type { StockRow } from '../../../resources/stock.ts';
import { stockBlocked, stockRetryOp, stockScreen, type StockProblem } from '../../../resources/stock-list.ts';
import { useStock } from '../../../resources/useStock.ts';
import { colors, space, type } from '../../../theme/tokens.ts';

/** Resources → Inventory: counted stock by location, read-only (docs/plans/expo-mobile-inventory-read-2026-09.md §3,
 *  §6). Names, locations, counts, reorder points and units are shown exactly as the API returned them. Groups and rows
 *  keep the parser's order (the API's, never re-sorted). There is no count, edit, add or archive control: one fixed link
 *  opens the website, where stock is counted. Rows are plain text, each read as one element. */
export default function Inventory() {
	const { state, inert, now, request } = useStock();
	const { webLink } = useAccount();
	useWaitWake(state.problem?.wait ?? null, now);
	const screen = stockScreen(state, inert);

	const blocked = stockBlocked(state, now());
	const reason = blocked === 'loading' ? stockCopy.busy
		: blocked === 'waiting' && state.problem?.wait ? `Try again after about ${formatAbout(state.problem.wait.about)}` : null;
	const retry = stockRetryOp(state);
	const tryAgain = retry === null ? null : (
		<Button testID="stock-try-again" label={stockCopy.tryAgain} disabled={blocked !== null} reason={reason} onPress={() => request(retry)} />
	);
	const problemNotice = (problem: StockProblem) => (
		<View testID="stock-problem" style={styles.stack}>
			<Notice title={stockCopy.heading}>{stockProblemText(problem)}</Notice>
			{tryAgain}
		</View>
	);
	const web = webLink('/resources/inventory');
	const loaded = screen.kind === 'empty' || screen.kind === 'list';
	// Sections in the parser's order (the API's; never re-sorted), keyed by position: a location is shown verbatim and
	// is never used as an ID.
	const sections: readonly Section[] = screen.kind === 'list'
		? screen.groups.map((group, index) => ({ key: String(index), index, location: group.location, data: group.items }))
		: [];

	return (
		<Screen section="resources" title={stockCopy.heading} list={({ heading, contentContainerStyle }) => (
			// The whole page scrolls in this one virtualised list (contract §4): the heading, subtitle, Refresh and any
			// problem are its header; the loading, failed or empty state is its empty component; the website link is its
			// footer. So every control stays reachable however long the list is.
			<SectionList<StockRow, Section>
				sections={sections}
				keyExtractor={(row) => row.id}
				stickySectionHeadersEnabled={false}
				contentContainerStyle={contentContainerStyle}
				ListHeaderComponent={
					<View style={styles.header}>
						{heading}
						<Text testID="stock-subtitle" style={styles.subtitle}>{stockCopy.subtitle}</Text>
						{loaded ? <Button testID="stock-refresh" label={stockCopy.refresh} disabled={blocked !== null} reason={reason} onPress={() => request('refresh')} /> : null}
						{loaded && screen.problem !== null ? problemNotice(screen.problem) : null}
					</View>
				}
				ListEmptyComponent={
					screen.kind === 'loading' ? <Text testID="stock-loading" style={styles.body}>{stockCopy.loading}</Text>
						: screen.kind === 'failed' ? problemNotice(screen.problem)
						: screen.kind === 'empty' ? <View testID="stock-empty"><Notice title={stockCopy.emptyTitle}>{stockCopy.emptyBody}</Notice></View>
						: null
				}
				ListFooterComponent={loaded && web !== null
					? <View style={styles.footer}><Button testID="stock-web" label={stockCopy.openWeb} onPress={() => { void Linking.openURL(web); }} /></View>
					: null}
				renderSectionHeader={({ section }) => (
					<Text testID={`stock-group-${section.index}`} role="heading" style={styles.location}>{section.location}</Text>
				)}
				renderItem={({ item }) => <Row row={item} />}
			/>
		)} />
	);
}

/** One location's rows, in order. `index` is its position, used for the key and the test ID. */
type Section = { readonly key: string; readonly index: number; readonly location: string; readonly data: readonly StockRow[] };

function Row({ row }: { row: StockRow }) {
	const reorder = stockReorderText(row);
	return (
		<View role="listitem" accessible aria-label={stockRowLabel(row)} testID={`stock-row-${row.id}`} style={styles.row}>
			<Text style={styles.name}>{row.name}</Text>
			<Text style={styles.count}>{stockCountText(row)}</Text>
			{reorder === null ? null : <Text style={styles.detail}>{reorder}</Text>}
			{row.below ? <Text testID={`stock-below-${row.id}`} style={styles.below}>{stockCopy.below}</Text> : null}
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
	header: { gap: 12, marginBottom: 12 },
	footer: { marginTop: 12 },
	location: { fontSize: type.body, fontWeight: '600', color: colors.heading, marginTop: 12, marginBottom: 8 },
	row: { minHeight: space.rowMinHeight, borderRadius: 14, borderWidth: 1, borderColor: colors.rowLine, backgroundColor: colors.card, padding: space.rowPadding, gap: 2, marginBottom: 8 },
	name: { fontSize: type.body, fontWeight: '600', color: colors.heading },
	count: { fontSize: type.body, color: colors.body },
	detail: { fontSize: 13, color: colors.muted },
	below: { fontSize: 13, fontWeight: '600', color: colors.body }
});
