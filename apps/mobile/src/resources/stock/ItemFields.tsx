/** A stock item's details as fields (stock contract §3): name, location with the existing locations offered, unit,
 *  reorder point and note. Used by "Add an item" on Stocktake and by the stock card, drawn as the task card's fields
 *  (design board 1: R3 `.field`, `.input`, `.facts`). Presentation only: the caller owns every value and action. */
import { Text, View } from 'react-native';
import { CardButton, Muted, TextField } from '../../threads/cards/Fields.tsx';
import { themedStyles } from '../../theme/theme.ts';
import { type } from '../../theme/tokens.ts';
import type { ItemDetails } from './stock.ts';

export function ItemFields({ form, set, disabled, locations, unitLocked = false, prefix }: {
	form: ItemDetails; set: (next: Partial<ItemDetails>) => void; disabled: boolean; locations: readonly string[]; unitLocked?: boolean; prefix: string;
}) {
	const styles = useStyles();
	// Up to eight existing locations other than the one typed, so a new item lands beside the ones already there.
	const offered = locations.filter((l) => l !== form.location.trim()).slice(0, 8);
	return <View style={styles.box}>
		<TextField label="Name" testID={`${prefix}-name`} value={form.name} onChange={(name) => set({ name })} disabled={disabled} maxLength={200} />
		<TextField label="Location" testID={`${prefix}-location`} value={form.location} onChange={(location) => set({ location })} disabled={disabled} maxLength={200} />
		{offered.length ? <View style={styles.offer} testID={`${prefix}-locations`}>
			<Text style={styles.legend}>Existing locations</Text>
			<View style={styles.chips}>{offered.map((l) => <CardButton key={l} testID={`${prefix}-location-choice`} label={`Location: ${l}`} display={l} quiet disabled={disabled} onPress={() => set({ location: l })} />)}</View>
		</View> : null}
		<View style={styles.facts}>
			<TextField label="Unit" testID={`${prefix}-unit`} value={form.unitLabel} onChange={(unitLabel) => set({ unitLabel })} disabled={disabled || unitLocked} maxLength={80} wide={false} placeholder="bags" />
			<TextField label="Reorder point (optional)" testID={`${prefix}-reorder`} value={form.reorderPoint} onChange={(reorderPoint) => set({ reorderPoint })} disabled={disabled} keyboard="decimal-pad" maxLength={80} wide={false} />
		</View>
		{unitLocked ? <Muted testID={`${prefix}-unit-locked`}>The unit stays as it is once an item has counts. Make a separate item to count in another unit.</Muted> : null}
		<TextField label="Notes (optional)" testID={`${prefix}-notes`} value={form.notes} onChange={(notes) => set({ notes })} disabled={disabled} maxLength={5000} />
	</View>;
}

const useStyles = themedStyles((colors) => ({
	box: { gap: 10 },
	facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
	offer: { gap: 2, marginTop: -4 },
	legend: { fontSize: type.label, color: colors.muted },
	chips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16 }
}));
