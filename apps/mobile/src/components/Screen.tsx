import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccount } from '../account/AccountProvider.tsx';
import { isSignedIn, signedInNotices, threadsCopy } from '../account/copy.ts';
import { colors, space, type } from '../theme/tokens.ts';
import { Notice } from './Notice.tsx';
import { Chevron, Magnifier } from './Icons.tsx';

/** What a list page gets from `Screen` so its own virtualised list scrolls the whole page: the heading (to put first in
 *  its list header) and the same content padding the scrolling page uses. */
export type ScreenListFrame = { readonly heading: ReactNode; readonly contentContainerStyle: StyleProp<ViewStyle> };

type Back = { readonly label: string; readonly onPress: () => void };
type ScreenProps = { title?: string; back?: Back } & (
	| { children: ReactNode; list?: undefined }
	/** A page whose content is one virtualised or self-scrolling view (the equipment timeline): `Screen` renders the
	 *  header, then a bounded, non-scrolling container holding what `list` returns. */
	| { list: (frame: ScreenListFrame) => ReactNode; children?: undefined }
);

/** A workspace page (docs/proposals/2026-09-29-chat-first-captain.md): a compact header with, on the left, a way back
 *  or the organisation's name, and on the right search and the account avatar, which opens `/settings`; then an
 *  optional 26 pt heading and the page. Content keeps a 16 pt gutter and a readable column on wide screens.
 *  Accessibility uses React Native's `role` and `aria-*` props, which iOS, Android and React Native Web all map. */
export function Screen({ title, back, children, list }: ScreenProps) {
	const insets = useSafeAreaInsets();
	const { snapshot } = useAccount();
	const account = snapshot.account;
	const organisation = isSignedIn(account) && account.org.kind === 'chosen' ? account.org.membership.organisationName : null;
	const contentContainerStyle = [styles.content, { paddingBottom: 32 + insets.bottom }];
	const titleNode = title ? <Text role="heading" style={styles.heading}>{title}</Text> : null;
	const heading = <>{titleNode}{isSignedIn(account) ? signedInNotices(account).map(line => <Notice key={line.title} title={line.title}>{line.text}</Notice>) : null}</>;
	return (
		<View style={[styles.page, { paddingTop: insets.top }]}>
			<View style={styles.header}>
				{back ? (
					<Pressable onPress={back.onPress} role="button" aria-label={back.label} hitSlop={6} style={styles.crumb}>
						<Chevron color={colors.body} /><Text style={styles.crumbText} numberOfLines={1}>{back.label}</Text>
					</Pressable>
				) : (
					<View style={styles.crumb}>{organisation === null ? null : <Text testID="shell-organisation" style={styles.crumbText} numberOfLines={1}>{organisation}</Text>}</View>
				)}
				<View style={styles.actions}>
					<Pressable disabled role="button" aria-label={threadsCopy.search} aria-disabled accessibilityHint={threadsCopy.searchHint} style={[styles.round, styles.dim]}>
						<Magnifier color={colors.muted} />
					</Pressable>
					<Pressable onPress={() => router.push('/settings')} role="button" aria-label={threadsCopy.account} hitSlop={4} style={[styles.round, styles.avatar]}>
						<View style={styles.head} /><View style={styles.shoulders} />
					</Pressable>
				</View>
			</View>
			{list ? <View style={styles.fill}>{list({ heading, contentContainerStyle })}</View> : (
				<ScrollView contentContainerStyle={contentContainerStyle}>
					{heading}
					{children}
				</ScrollView>
			)}
		</View>
	);
}

/** A page outside the shell (the refusal page, a step-up): a plain way back and a heading. */
export function PlainScreen({ title, back, children }: { title: string; back: Back | null; children: ReactNode }) {
	const insets = useSafeAreaInsets();
	return (
		<View style={[styles.page, { paddingTop: insets.top }]}>
			<View style={styles.header}>
				{back === null ? <View style={styles.crumb} /> : (
					<Pressable onPress={back.onPress} role="button" aria-label={back.label} hitSlop={6} style={styles.crumb}>
						<Chevron color={colors.body} /><Text style={styles.crumbText} numberOfLines={1}>{back.label}</Text>
					</Pressable>
				)}
			</View>
			<ScrollView contentContainerStyle={[styles.content, { paddingBottom: 32 + insets.bottom }]}>
				<Text role="heading" style={styles.heading}>{title}</Text>
				{children}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	page: { flex: 1, backgroundColor: colors.page },
	fill: { flex: 1 },
	header: {
		minHeight: 52, paddingHorizontal: space.page - 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
		width: '100%', maxWidth: space.maxContentWidth, alignSelf: 'center'
	},
	content: { paddingHorizontal: space.page, width: '100%', maxWidth: space.maxContentWidth, alignSelf: 'center' },
	crumb: { minHeight: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', flexShrink: 1, paddingHorizontal: 4 },
	crumbText: { fontSize: type.body, color: colors.body, fontWeight: '600' },
	actions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
	dim: { opacity: 0.45 },
	avatar: { backgroundColor: colors.sage, overflow: 'hidden' },
	head: { width: 13, height: 13, borderRadius: 7, backgroundColor: colors.sageText, marginTop: 8 },
	shoulders: { width: 26, height: 14, borderTopLeftRadius: 13, borderTopRightRadius: 13, backgroundColor: colors.sageText, marginTop: 3 },
	heading: { fontSize: type.heading, lineHeight: 32, fontWeight: '600', color: colors.heading, marginTop: 4, marginBottom: 14 }
});
