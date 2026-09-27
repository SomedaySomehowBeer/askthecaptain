import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { sectionOf, type SectionKey, type ViewRow } from '../navigation/sections.ts';
import { colors, space, type } from '../theme/tokens.ts';
import { SectionIcon } from './Icons.tsx';

/** A section's grouped view list, one page to the left of its selected view (plan D11). No visible page title; each
 *  group title is an accessible heading. A view this build cannot show is listed as unavailable and cannot be opened.
 *  There is no creation action here: nothing can be created until sign-in and writes arrive. Accessibility uses
 *  React Native's `role` and `aria-*` props, which iOS, Android and React Native Web all map. */
export function ViewList({ section }: { section: SectionKey }) {
	const current = sectionOf(section);
	return (
		<View style={styles.list}>
			{current.groups.map((group) => (
				<View key={group.title} style={styles.group}>
					<Text role="heading" style={styles.groupTitle}>{group.title}</Text>
					<View style={styles.card}>
						{group.rows.map((row, index) => <Row key={row.label} row={row} section={section} last={index === group.rows.length - 1} />)}
					</View>
				</View>
			))}
		</View>
	);
}

function Row({ row, section, last }: { row: ViewRow; section: SectionKey; last: boolean }) {
	const content = (
		<>
			<View style={styles.icon}><SectionIcon name={section} color={row.href ? colors.check : colors.muted} size={18} /></View>
			<View style={styles.text}>
				<Text style={[styles.label, row.href ? null : styles.unavailable]}>{row.label}</Text>
				<Text style={styles.detail}>{row.detail}</Text>
			</View>
		</>
	);
	const style = [styles.row, last ? styles.lastRow : null];
	if (!row.href) return (
		<View style={style} accessible aria-label={`${row.label}. ${row.detail}`} aria-disabled>{content}</View>
	);
	const href = row.href;
	return (
		<Pressable style={style} onPress={() => router.navigate(href)} role="link" aria-label={`${row.label}. ${row.detail}`}>
			{content}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	list: { gap: 18, paddingTop: 4 },
	group: { gap: 8 },
	groupTitle: { fontSize: type.rowTitle, fontWeight: '600', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginLeft: 4 },
	card: { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
	row: { minHeight: space.rowMinHeight, padding: space.rowPadding, flexDirection: 'row', gap: 12, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.rowLine },
	lastRow: { borderBottomWidth: 0 },
	icon: { width: space.viewIcon, height: space.viewIcon, borderRadius: space.viewIconRadius, backgroundColor: colors.viewIcon, alignItems: 'center', justifyContent: 'center' },
	text: { flex: 1, minWidth: 0 },
	label: { fontSize: type.rowTitle, fontWeight: '600', color: colors.heading },
	unavailable: { color: colors.muted },
	detail: { marginTop: 4, fontSize: type.rowDetail, lineHeight: type.rowDetailLine, color: colors.muted }
});
