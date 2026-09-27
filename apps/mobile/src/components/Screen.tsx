import { router, useNavigation } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sectionOf, type SectionKey } from '../navigation/sections.ts';
import { colors, space, tabBar, type } from '../theme/tokens.ts';
import { Chevron, Magnifier } from './Icons.tsx';

/** A workspace page (mockup README): a compact header with a breadcrumb back to the section's view list, search and
 *  the account avatar, with no logo or wordmark; then an optional 26 pt heading and the page. Content leaves room for
 *  the floating tab bar. A view list passes no title: its groups carry the context. Accessibility uses React Native's
 *  `role` and `aria-*` props, which iOS, Android and React Native Web all map. */
export function Screen({ section, title, onViewList = false, children }: { section: SectionKey; title?: string; onViewList?: boolean; children: ReactNode }) {
	const insets = useSafeAreaInsets(); const current = sectionOf(section); const navigation = useNavigation();
	// Back to this section's view list when it is in this stack; otherwise open it, so it never leaves the section and,
	// on the web, never pops to a route without its own history entry. On iOS and Android the view list is beneath every
	// section stack built through the entries in docs/plans/expo-mobile-native-navigation-2026-09.md (source-proven; its
	// device gates are still open); the push branch remains for the web and as a defensive path.
	const toViews = () => {
		const routes = (navigation.getState()?.routes ?? []) as { name: string }[];
		if (routes.some((route) => route.name === 'views')) router.dismissTo(current.viewsHref);
		else router.push(current.viewsHref);
	};
	return (
		<View style={[styles.page, { paddingTop: insets.top }]}>
			<View style={styles.header}>
				{onViewList ? <View style={styles.crumb} /> : (
					<Pressable onPress={toViews} role="button" aria-label={current.viewsLabel} accessibilityHint="Shows the list of views" hitSlop={6} style={styles.crumb}>
						<Chevron color={colors.body} /><Text style={styles.crumbText} numberOfLines={1}>{current.label}</Text>
					</Pressable>
				)}
				<View style={styles.actions}>
					<Pressable disabled role="button" aria-label="Search" aria-disabled accessibilityHint="Not available in this build yet" style={[styles.round, styles.dim]}>
						<Magnifier color={colors.muted} />
					</Pressable>
					<Pressable onPress={() => router.push('/settings')} role="button" aria-label="Account and settings" hitSlop={4} style={[styles.round, styles.avatar]}>
						<View style={styles.head} /><View style={styles.shoulders} />
					</Pressable>
				</View>
			</View>
			<ScrollView aria-label={onViewList ? current.viewsLabel : undefined} contentContainerStyle={{ paddingHorizontal: space.page, paddingBottom: tabBar.contentClearance + insets.bottom }}>
				{title ? <Text role="heading" style={styles.heading}>{title}</Text> : null}
				{children}
			</ScrollView>
		</View>
	);
}

/** A page outside the three sections (Settings, a refused link): a plain way back and a heading. */
export function PlainScreen({ title, back, children }: { title: string; back: { label: string; onPress: () => void }; children: ReactNode }) {
	const insets = useSafeAreaInsets();
	return (
		<View style={[styles.page, { paddingTop: insets.top }]}>
			<View style={styles.header}>
				<Pressable onPress={back.onPress} role="button" aria-label={back.label} hitSlop={6} style={styles.crumb}>
					<Chevron color={colors.body} /><Text style={styles.crumbText} numberOfLines={1}>{back.label}</Text>
				</Pressable>
			</View>
			<ScrollView contentContainerStyle={{ paddingHorizontal: space.page, paddingBottom: 32 + insets.bottom }}>
				<Text role="heading" style={styles.heading}>{title}</Text>
				{children}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	page: { flex: 1, backgroundColor: colors.page },
	header: { minHeight: 52, paddingHorizontal: space.page - 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
	crumb: { minHeight: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
	crumbText: { fontSize: type.body, color: colors.body, fontWeight: '600' },
	actions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
	dim: { opacity: 0.45 },
	avatar: { backgroundColor: colors.sage, overflow: 'hidden' },
	head: { width: 13, height: 13, borderRadius: 7, backgroundColor: colors.body, marginTop: 8 },
	shoulders: { width: 26, height: 14, borderTopLeftRadius: 13, borderTopRightRadius: 13, backgroundColor: colors.body, marginTop: 3 },
	heading: { fontSize: type.heading, lineHeight: 32, fontWeight: '600', color: colors.heading, marginTop: 4, marginBottom: 14 }
});
