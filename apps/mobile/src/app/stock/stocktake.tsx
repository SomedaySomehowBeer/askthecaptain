/** `/stock/stocktake` (docs/plans/stock-2026-10.md §3; design board 12, Stocktake.dc.html): every active item grouped by
 *  location with its last count, a numeric field per row, "Add an item" at the end, and the bottom bar ("n of m
 *  counted", Cancel, "Save stocktake"). One save is one change set; its rules are in resources/stock/stocktake.ts. The
 *  back link returns to the thread list (board README: "‹ Threads always returns to the thread list"). */
import { router } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useAccount } from '../../account/AccountProvider.tsx';
import type { ReadScope } from '../../account/contracts.ts';
import { isSignedIn, webCopy } from '../../account/copy.ts';
import { PlainText, Screen } from '../../components/Screen.tsx';
import type { ThreadCalls } from '../../threads/api.ts';
import { copy } from '../../threads/copy.ts';
import { CardButton, Muted, Note } from '../../threads/cards/Fields.tsx';
import { send } from '../../threads/cards/records.ts';
import { useSaver, type CardHooks } from '../../threads/cards/useSaver.ts';
import { useDeadline } from '../../threads/use-poll.ts';
import { ItemFields } from '../../resources/stock/ItemFields.tsx';
import { groupByLocation, itemProblem, lastCountWords, parseStockList, stockListPath, stockRefusals, stockWrites, type NewItem, type StockItem, type StockList } from '../../resources/stock/stock.ts';
import { browserStocktakes, createStocktake, stocktakeCopy, stocktakeFlash, stocktakeLines } from '../../resources/stock/stocktake.ts';
import { themedStyles, useTheme } from '../../theme/theme.ts';
import { faces, familyFor, type } from '../../theme/tokens.ts';
import Welcome from '../welcome.tsx';

const toList = () => router.dismissTo('/');
export default function StocktakePage() {
	const account = useAccount(), view = account.snapshot.account;
	const back = { label: 'Threads', onPress: toList };
	if (view.kind === 'checking' || view.kind === 'starting') return <Screen record back={back}><PlainText>{webCopy.checking}</PlainText></Screen>;
	if (view.kind === 'unverified') return <Welcome />;
	if (!isSignedIn(view)) return null;
	if (!account.web || !view.scope || view.org.kind !== 'chosen') return <Screen record back={back}><PlainText>{copy.unavailable}</PlainText></Screen>;
	return <Stocktake key={view.scope.epoch} calls={account.web.threads} scope={view.scope} now={account.now} />;
}

const emptyItem: NewItem = { name: '', location: '', unitLabel: '', reorderPoint: '', notes: '' };
const addCopy = { saving: 'Adding the item…', saved: 'Item added.', confirmed: 'Confirmed: the item is added.', refusals: stockRefusals };

function Stocktake({ calls, scope, now }: { calls: ThreadCalls; scope: ReadScope; now: () => number }) {
	const styles = useStyles();
	const [controller] = useState(() => createStocktake({ calls, scope, now, randomId: () => Crypto.randomUUID(), storage: browserStocktakes }));
	useEffect(() => { void controller.load(); return () => controller.dispose(); }, [controller]);
	const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
	const waiting = useDeadline(state.waitUntil, now);
	const [adding, setAdding] = useState<NewItem | null>(null);
	const [added, setAdded] = useState('');
	const [confirmCancel, setConfirmCancel] = useState(false);
	const [archived, setArchived] = useState(false);
	const [hooks] = useState<CardHooks>(() => ({ now, saved: () => {}, reload: () => {}, lost: () => {} }));
	const [addSaver, addState] = useSaver<StockItem & { changeSetId: string }>({ ...hooks, saved: () => { void controller.load(); }, reload: () => { void controller.load(); } }, addCopy,
		(item) => { setAdding(null); setAdded(item ? `Added ${item.name} to ${item.location}.` : 'Item added.'); });
	const addWaiting = useDeadline(addState.waitUntil, now);
	// Success: back to the thread list, which says what was saved.
	useEffect(() => { if (state.saved !== null) { stocktakeFlash.set(scope, stocktakeCopy.saved(state.saved)); toList(); } }, [state.saved]);

	if (state.phase === 'lost') return <Screen record back={{ label: 'Threads', onPress: toList }}><Note tone="warn" testID="stocktake-lost">{stocktakeCopy.lost}</Note></Screen>;
	const items = state.list?.items ?? [];
	const { counted, problems } = stocktakeLines(items, state.values);
	const locked = state.busy || state.uncertain;
	const typed = Object.values(state.values).filter((v) => v.trim()).length;
	const year = new Date().getFullYear(); // wall clock: `now` is monotonic
	const zone = state.list?.timezone;
	const addProblem = adding ? itemProblem(adding) : null;
	const addLocked = addState.busy || addState.uncertain || addWaiting;
	return <Screen record back={{ label: 'Threads', onPress: toList }} list={(frame) => <View style={{ flex: 1 }}>
		<ScrollView testID="stocktake" contentContainerStyle={[frame.contentContainerStyle, styles.content]} keyboardShouldPersistTaps="handled">
			<Text role="heading" testID="stocktake-heading" style={styles.heading}>{stocktakeCopy.heading}</Text>
			{frame.heading}
			<Text style={styles.sub}>{stocktakeCopy.hint}</Text>
			{state.message ? <Text testID="stocktake-status" role="status" style={[styles.status, state.tone === 'warn' && styles.warn]}>{state.message}</Text> : null}
			{state.uncertain ? <View style={styles.row}>
				<CardButton testID="stocktake-retry" label="Save again with the same change ID" display="Save again with the same ID" primary grow disabled={state.busy || waiting} onPress={() => { void controller.retry(); }} />
				<CardButton testID="stocktake-discard" label="Discard this save" display="Discard" disabled={state.busy} onPress={() => controller.discard()} />
			</View> : null}
			{state.phase === 'loading' ? <Text testID="stocktake-loading" style={styles.body}>{stocktakeCopy.loading}</Text> : null}
			{state.phase === 'failed' ? <View style={styles.stack}><Note tone="warn" testID="stocktake-failed">{state.message || stocktakeCopy.failed}</Note>
				<CardButton testID="stocktake-try-again" label="Try again" onPress={() => { void controller.load(); }} /></View> : null}
			{state.phase === 'ready' && items.length === 0 ? <Text testID="stocktake-empty" style={styles.body}>{stocktakeCopy.empty}</Text> : null}
			{groupByLocation(items).map((g) => <View key={g.location} style={styles.stack8}>
				<Text role="heading" aria-level={2} style={styles.loc}>{g.location}</Text>
				<View style={styles.group} testID={`stocktake-group-${g.location}`}>
					{g.items.map((item, i) => <CountRow key={item.id} item={item} last={i === g.items.length - 1} value={state.values[item.id] ?? ''} disabled={locked}
						stale={state.stale.includes(item.id)} problem={problems[item.id] ?? null} detail={lastCountWords(item, zone, year)} onChange={(v) => controller.type(item.id, v)} />)}
				</View>
			</View>)}
			{added ? <Text testID="stocktake-added" role="status" style={styles.status}>{added}</Text> : null}
			{adding ? <View style={styles.card} testID="stocktake-add">
				<Text role="heading" aria-level={2} style={styles.addHeading}>Add an item</Text>
				<ItemFields prefix="stocktake-add" form={adding} set={(next) => { setAdding({ ...adding, ...next }); if (!addLocked) addSaver.clear(); }} disabled={addLocked} locations={state.list?.locations ?? []} />
				{addProblem && (adding.name || adding.location || adding.unitLabel) ? <Muted testID="stocktake-add-invalid">{addProblem}</Muted> : null}
				<View style={styles.row}>
					{addState.uncertain
						? <><CardButton testID="stocktake-add-retry" label="Add the item again with the same change ID" display="Save again" primary grow disabled={addState.busy || addWaiting} onPress={() => { void addSaver.retry(); }} />
							<CardButton testID="stocktake-add-discard" label="Discard adding the item" display="Discard" disabled={addState.busy} onPress={() => { addSaver.discard(); }} /></>
						: <><CardButton testID="stocktake-add-save" label="Add item" primary grow disabled={addLocked || Boolean(addProblem)} onPress={() => {
							const form = adding;
							void addSaver.save((id) => { const w = stockWrites.add(scope, id, form); return { body: w.body, send: () => send(calls, scope, w) }; });
						}} />
							<CardButton testID="stocktake-add-cancel" label="Cancel adding an item" display="Cancel" disabled={addState.busy} onPress={() => { setAdding(null); addSaver.clear(); }} /></>}
				</View>
				{addState.message ? <Text testID="stocktake-add-status" role="status" style={[styles.status, addState.tone === 'warn' && styles.warn]}>{addState.message}</Text> : null}
			</View> : state.phase === 'ready' ? <View style={styles.row}>
				<CardButton testID="stocktake-add-open" label="Add an item" quiet onPress={() => { setAdded(''); addSaver.clear(); setAdding(emptyItem); }} />
				<View style={styles.grow} />
				<CardButton testID="stocktake-show-archived" label={archived ? 'Hide archived' : 'Show archived'} quiet onPress={() => setArchived(!archived)} />
			</View> : null}
			{archived ? <Archived calls={calls} scope={scope} now={now} zone={zone} year={year} onRestored={() => { void controller.load(); }} /> : null}
		</ScrollView>
		<View testID="stocktake-bar" style={styles.bar}>
			{confirmCancel ? <>
				<Text testID="stocktake-cancel-confirm" style={[styles.barText, styles.grow]}>{stocktakeCopy.discardConfirm(typed)}</Text>
				<CardButton testID="stocktake-cancel-keep" label="Keep counting" onPress={() => setConfirmCancel(false)} />
				<CardButton testID="stocktake-cancel-discard" label="Discard the typed counts" display="Discard" primary onPress={() => { controller.cancel(); setConfirmCancel(false); toList(); }} />
			</> : <>
				<Text testID="stocktake-counted" role="status" style={[styles.value, styles.grow]}>{stocktakeCopy.counted(counted, items.length)}</Text>
				<CardButton testID="stocktake-cancel" label="Cancel" disabled={state.busy} onPress={() => { if (typed && !state.uncertain) setConfirmCancel(true); else toList(); }} />
				<CardButton testID="stocktake-save" label="Save stocktake" primary disabled={locked || waiting || state.phase !== 'ready' || counted === 0 || Object.keys(problems).length > 0}
					onPress={() => { setAdded(''); void controller.save(); }} />
			</>}
		</View>
	</View>} />;
}

/** Board 12's row: the name over the last count, and the count field on the right (the unit as its placeholder; a filled
 *  field turns the counted style). The whole row focuses the field, as the board's `<label>` does. */
function CountRow({ item, value, disabled, stale, problem, detail, last, onChange }: {
	item: StockItem; value: string; disabled: boolean; stale: boolean; problem: string | null; detail: string; last: boolean; onChange: (v: string) => void;
}) {
	const styles = useStyles();
	const { colors } = useTheme();
	const input = useRef<TextInput>(null);
	const filled = value.trim() !== '';
	// "330 ml cans" in cans needs no unit after it; "Pale malt" in bags reads "Pale malt, bags".
	const label = item.name.toLowerCase().includes(item.unitLabel.toLowerCase()) ? item.name : `${item.name}, ${item.unitLabel}`;
	return <Pressable testID={`stocktake-row-${item.id}`} onPress={() => input.current?.focus()} accessible={false} style={[styles.item, !last && styles.divided]}>
		<View style={styles.itemText}>
			<Text style={styles.itemName}>{item.name}</Text>
			<Text testID={`stocktake-last-${item.id}`} style={styles.itemLast}>{detail}</Text>
			{stale ? <Text testID={`stocktake-stale-${item.id}`} style={styles.rowWarn}>{stocktakeCopy.staleRow}</Text> : null}
			{problem ? <Text testID={`stocktake-invalid-${item.id}`} style={styles.rowWarn}>{problem}</Text> : null}
		</View>
		<TextInput ref={input} testID={`stocktake-count-${item.id}`} aria-label={label} accessibilityLabel={label} value={value} onChangeText={onChange} editable={!disabled} aria-disabled={disabled}
			placeholder={item.unitLabel} placeholderTextColor={colors.muted} keyboardType="decimal-pad" inputMode="decimal" maxLength={80}
			style={[styles.count, filled && styles.countDone, stale && styles.countStale, disabled && styles.off]} />
	</Pressable>;
}

/** "Show archived" (stock contract §1): archived items, each restorable after a confirm step, as one revision-checked write. */
function Archived({ calls, scope, now, zone, year, onRestored }: { calls: ThreadCalls; scope: ReadScope; now: () => number; zone?: string; year: number; onRestored: () => void }) {
	const styles = useStyles();
	const [list, setList] = useState<StockList | null | 'failed'>(null);
	const [asking, setAsking] = useState<string | null>(null);
	const [n, setN] = useState(0);
	useEffect(() => {
		let live = true;
		void calls.request(scope, 'GET', stockListPath(scope, true), undefined, (v) => parseStockList(v, true)).then((r) => {
			if (!live || r.kind === 'stale') return;
			setList(r.kind === 'ok' ? r.value : 'failed');
		});
		return () => { live = false; };
	}, [n]);
	const [hooks] = useState<CardHooks>(() => ({ now, saved: () => {}, reload: () => {}, lost: () => {} }));
	const [saver, state] = useSaver<StockItem & { changeSetId: string }>({ ...hooks, saved: () => { setAsking(null); setN((v) => v + 1); onRestored(); }, reload: () => setN((v) => v + 1) },
		{ saving: 'Restoring…', saved: 'Restored. It is back in Stocktake and the Stock filter.', confirmed: 'Restore confirmed.', refusals: stockRefusals });
	const waiting = useDeadline(state.waitUntil, now);
	const rows = list && list !== 'failed' ? list.items.filter((i) => i.archivedAt !== null) : [];
	const locked = state.busy || state.uncertain || waiting;
	return <View style={styles.stack8} testID="stocktake-archived">
		<Text role="heading" aria-level={2} style={styles.loc}>Archived items</Text>
		{list === null ? <Text style={styles.body}>{stocktakeCopy.loading}</Text> : null}
		{list === 'failed' ? <Note tone="warn" testID="stocktake-archived-failed">Couldn’t load the archived items. Try again.</Note> : null}
		{list && list !== 'failed' && rows.length === 0 ? <Text testID="stocktake-archived-empty" style={styles.body}>No archived items.</Text> : null}
		{state.message ? <Text testID="stocktake-archived-status" role="status" style={[styles.status, state.tone === 'warn' && styles.warn]}>{state.message}</Text> : null}
		{state.uncertain ? <View style={styles.row}>
			<CardButton testID="stocktake-restore-retry" label="Save again with the same change ID" display="Save again" primary grow disabled={state.busy || waiting} onPress={() => { void saver.retry(); }} />
			<CardButton testID="stocktake-restore-discard" label="Discard the restore" display="Discard" disabled={state.busy} onPress={() => saver.discard()} />
		</View> : null}
		{rows.length ? <View style={styles.group}>{rows.map((item, i) => <View key={item.id} testID={`stocktake-archived-${item.id}`} style={[styles.archivedRow, i < rows.length - 1 && styles.divided]}>
			<View style={styles.line}>
				<View style={styles.itemText}><Text style={styles.itemName}>{item.name}</Text><Text style={styles.itemLast}>{`${item.location} · ${lastCountWords(item, zone, year)}`}</Text></View>
				<CardButton testID={`stocktake-restore-${item.id}`} label={`Restore ${item.name}`} display="Restore" quiet disabled={locked || asking !== null} onPress={() => { saver.clear(); setAsking(item.id); }} />
			</View>
			{asking === item.id ? <View style={styles.stack}>
				<Note tone="neutral">{`Restore ${item.name}? It returns to Stocktake and the Stock filter.`}</Note>
				<View style={styles.row}>
					<CardButton testID={`stocktake-restore-yes-${item.id}`} label={`Restore ${item.name}`} display="Restore it" primary grow disabled={locked}
						onPress={() => { void saver.save((id) => { const w = stockWrites.archive(scope, item, id, false); return { body: w.body, send: () => send(calls, scope, w) }; }); }} />
					<CardButton testID={`stocktake-restore-no-${item.id}`} label={`Keep ${item.name} archived`} display="Keep it" disabled={state.busy} onPress={() => setAsking(null)} />
				</View>
			</View> : null}
		</View>)}</View> : null}
	</View>;
}

/** R3 captain.css with board 12's own rules: `.h1`, `.sub`, `.scroll` (12 pt from the edges, 8 pt apart), `.loc`, `.group`,
 *  `.item`, `.item-name`, `.item-last`, `.count`, `.count-done`, `.bar`. */
const useStyles = themedStyles((colors) => ({
	content: { paddingHorizontal: 12, gap: 8, paddingBottom: 24 },
	heading: { fontFamily: faces.display, fontSize: type.pageHeading, lineHeight: type.pageHeadingLine, color: colors.heading, paddingHorizontal: 4, marginBottom: 2 },
	sub: { fontSize: type.small, lineHeight: type.smallLine, color: colors.muted, paddingHorizontal: 4, marginBottom: 2 },
	body: { fontSize: type.small, lineHeight: type.smallLine, color: colors.body, paddingHorizontal: 4 },
	status: { fontSize: type.small, lineHeight: type.smallLine, color: colors.body, paddingHorizontal: 4 },
	warn: { color: colors.warningText },
	stack: { gap: 10 },
	stack8: { gap: 8 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	line: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
	grow: { flex: 1, minWidth: 0 },
	loc: { fontSize: type.section, lineHeight: 15, fontWeight: '700', letterSpacing: 0.9, textTransform: 'uppercase', color: colors.muted, paddingTop: 6, paddingHorizontal: 4, paddingBottom: 4, marginBottom: -4 },
	group: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, overflow: 'hidden', backgroundColor: colors.card },
	item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.card },
	archivedRow: { paddingHorizontal: 12, paddingVertical: 4, gap: 8, backgroundColor: colors.card },
	divided: { borderBottomWidth: 1, borderColor: colors.rowLine },
	itemText: { flex: 1, minWidth: 0 },
	itemName: { fontSize: type.body, lineHeight: type.bodyLine, fontWeight: '600', color: colors.heading },
	itemLast: { fontSize: type.label, lineHeight: 17, color: colors.muted },
	rowWarn: { fontSize: type.label, lineHeight: 17, color: colors.warningText, marginTop: 2 },
	count: { width: 92, minHeight: 44, borderWidth: 1, borderColor: colors.fieldLine, borderRadius: 10, backgroundColor: colors.card, paddingHorizontal: 10, fontSize: 17,
		fontFamily: familyFor('regular', true), color: colors.heading, textAlign: 'right', outlineWidth: 0 },
	countDone: { borderColor: colors.action, backgroundColor: colors.needsYou },
	countStale: { borderColor: colors.warningLine },
	off: { opacity: 0.6 },
	card: { gap: 10, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 14 },
	addHeading: { fontSize: type.body, fontWeight: '700', color: colors.heading },
	bar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 14, borderTopWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
	value: { fontSize: type.body, fontWeight: '600', color: colors.heading },
	barText: { fontSize: type.small, lineHeight: type.smallLine, color: colors.heading }
}));
