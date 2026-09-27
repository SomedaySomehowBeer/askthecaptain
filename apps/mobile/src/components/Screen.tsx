import { router, useNavigation } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sectionOf, type SectionKey } from '../navigation/sections.ts';
import { colors, space, tabBar, type } from '../theme/tokens.ts';
import { Chevron, Magnifier } from './Icons.tsx';

/** What a list page gets from `Screen` so its own virtualised list scrolls the whole page: the heading (to put first in
 *  its list header) and the same content padding the scrolling page uses. */
export type ScreenListFrame = { readonly heading: ReactNode; readonly contentContainerStyle: StyleProp<ViewStyle> };

type ScreenProps = { section: SectionKey; title?: string; onViewList?: boolean } & (
	| { children: ReactNode; list?: undefined }
	/** A page whose content is one virtualised list (Inventory): `Screen` renders the header, then a bounded, non-scrolling
	 *  container holding what `list` returns, so the list is never nested inside a ScrollView. */
	| { list: (frame: ScreenListFrame) => ReactNode; children?: undefined }
);

/** A workspace page (mockup README): a compact header with a breadcrumb back to the section's view list, search and
 *  the account avatar, with no logo or wordmark; then an optional 26 pt heading and the page. Content leaves room for
 *  the floating tab bar. A view list passes no title: its groups carry the context. Accessibility uses React Native's
 *  `role` and `aria-*` props, which iOS, Android and React Native Web all map.
 *
 *  By default the page scrolls in a ScrollView. A page that passes `list` instead scrolls in its own virtualised list,
 *  with the same header, heading, padding and tab-bar clearance. */
export function Screen({ section, title, onViewList = false, children, list }: ScreenProps) {
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
	const contentContainerStyle = { paddingHorizontal: space.page, paddingBottom: tabBar.contentClearance + insets.bottom };
	const heading = title ? <Text role="heading" style={styles.heading}>{title}</Text> : null;
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
			{list ? <View style={styles.fill}>{list({ heading, contentContainerStyle })}</View> : (
				<ScrollView aria-label={onViewList ? current.viewsLabel : undefined} contentContainerStyle={contentContainerStyle}>
					{heading}
					{children}
				</ScrollView>
			)}
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
	fill: { flex: 1 },
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
