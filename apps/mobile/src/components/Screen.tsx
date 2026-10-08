import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccount } from '../account/AccountProvider.tsx';
import { isSignedIn, signedInNotices, threadsCopy } from '../account/copy.ts';
import { faces, space, type } from '../theme/tokens.ts';
import { initials } from '../threads/Presentation.tsx';
import { themedStyles, useTheme } from '../theme/theme.ts';
import { Notice } from './Notice.tsx';
import { Chevron, Magnifier } from './Icons.tsx';

/** What a list page gets from `Screen` so its own virtualised list scrolls the whole page: the heading (to put first in
 *  its list header) and the same content padding the scrolling page uses. */
export type ScreenListFrame = { readonly heading: ReactNode; readonly contentContainerStyle: StyleProp<ViewStyle> };

type Back = { readonly label: string; readonly onPress: () => void };
/** The thread list's search (H4): the header's magnifier opens and closes its field. Without it the magnifier is shown
 *  and disabled, as before. */
type HeaderSearch = { readonly open: boolean; readonly onPress: () => void };
type ScreenProps = { title?: string; back?: Back; headerAction?: ReactNode; search?: HeaderSearch } & (
	| { children: ReactNode; list?: undefined }
	/** A page whose content is one virtualised or self-scrolling view (the equipment timeline): `Screen` renders the
	 *  header, then a bounded, non-scrolling container holding what `list` returns. */
	| { list: (frame: ScreenListFrame) => ReactNode; children?: undefined }
);

/** A workspace page (docs/proposals/2026-09-29-chat-first-captain.md; drawn in the chat-first prototype and the R3
 *  boards): a compact header with, on the left, a way back or, on the thread list, the heading itself, and on the right
 *  search and the account avatar (the person's initials), which opens `/settings`; then an optional heading and the
 *  page. `record` is a thread or its History (R3 boards: a 15 pt back link, a 36 pt avatar, no search, the 26 pt
 *  History heading); otherwise the prototype's shell (a 12 pt crumb, a 30 pt avatar, search, 22 pt headings). Content
 *  keeps a 16 pt gutter and a readable column on wide screens. Accessibility uses React Native's `role` and `aria-*`
 *  props, which iOS, Android and React Native Web all map. */
export function Screen({ title, back, children, list, headerAction, search, record = false }: ScreenProps & { record?: boolean }) {
	const styles = useStyles();
	const { colors } = useTheme();
	const insets = useSafeAreaInsets();
	const { snapshot } = useAccount();
	const account = snapshot.account;
	const organisation = isSignedIn(account) && account.org.kind === 'chosen' ? account.org.membership.organisationName : null;
	const person = isSignedIn(account) ? account.user.name || account.user.email : null;
	const contentContainerStyle = [styles.content, { paddingBottom: 32 + insets.bottom }];
	// The thread list's heading sits in the header row (prototype frame 1); a page with a way back has it below.
	const inHeader = Boolean(title) && !back;
	const titleNode = title && !inHeader ? <Text role="heading" style={record ? styles.pageHeading : styles.heading}>{title}</Text> : null;
	const heading = <>{titleNode}{isSignedIn(account) ? signedInNotices(account).map(line => <Notice key={line.title} title={line.title}>{line.text}</Notice>) : null}</>;
	return (
		<View style={[styles.page, { paddingTop: insets.top }]}>
			<View style={[styles.header, record && styles.recordHeader]}>
				{back ? (
					<Pressable onPress={back.onPress} role="button" aria-label={back.label} hitSlop={6} style={styles.crumb}>
						<Chevron color={record ? colors.heading : colors.muted} size={record ? 'large' : 'small'} /><Text style={record ? styles.backText : styles.crumbText} numberOfLines={1}>{back.label}</Text>
					</Pressable>
				) : (
					<View style={styles.titleBox}>
						{inHeader ? <Text role="heading" style={styles.headerTitle} numberOfLines={1}>{title}</Text> : null}
						{organisation === null ? null : <Text testID="shell-organisation" style={styles.organisation} numberOfLines={1}>{organisation}</Text>}
					</View>
				)}
				<View style={styles.actions}>
					{headerAction}
					{record ? null : search ? (
						<Pressable testID="threads-search-toggle" onPress={search.onPress} role="button" aria-label={search.open ? threadsCopy.searchClose : threadsCopy.search}
							aria-expanded={search.open} hitSlop={4} style={[styles.round, search.open && { backgroundColor: colors.sage, borderRadius: 22 }]}>
							<Magnifier color={colors.body} />
						</Pressable>
					) : (
						<Pressable disabled role="button" aria-label={threadsCopy.search} aria-disabled accessibilityHint={threadsCopy.searchHint} style={styles.round}>
							<Magnifier color={colors.body} />
						</Pressable>
					)}
					<Pressable onPress={() => router.push('/settings')} role="button" aria-label={threadsCopy.account} hitSlop={4} style={styles.round}>
						<View aria-hidden style={[styles.avatar, record && styles.avatarLarge]}><Text style={[styles.avatarText, record && styles.avatarTextLarge]}>{person === null ? '' : initials(person)}</Text></View>
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

/** A page outside the shell (the refusal page, a step-up, Account and its pages): a plain way back and a heading. */
export function PlainScreen({ title, back, children }: { title: string; back: Back | null; children: ReactNode }) {
	const styles = useStyles();
	const { colors } = useTheme();
	const insets = useSafeAreaInsets();
	return (
		<View style={[styles.page, { paddingTop: insets.top }]}>
			<View style={styles.header}>
				{back === null ? <View style={styles.crumb} /> : (
					<Pressable onPress={back.onPress} role="button" aria-label={back.label} hitSlop={6} style={styles.crumb}>
						<Chevron color={colors.muted} size="small" /><Text style={styles.crumbText} numberOfLines={1}>{back.label}</Text>
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

/** Text with no designed style of its own (a loading or unavailable line on a page): the body face and colour. */
export function PlainText({ children, testID, role }: { children: ReactNode; testID?: string; role?: 'status' }) {
	const styles = useStyles();
	return <Text testID={testID} role={role} style={styles.plain}>{children}</Text>;
}

const useStyles = themedStyles((colors) => ({
	page: { flex: 1, backgroundColor: colors.page },
	fill: { flex: 1 },
	// Prototype frames 2 and 3 `.head` (6 px 12 px 0, the crumb 12/600 muted with a 16 pt chevron); R3 `.top`.
	header: {
		minHeight: 50, paddingTop: 6, paddingLeft: 12, paddingRight: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
		width: '100%', maxWidth: space.maxContentWidth, alignSelf: 'center'
	},
	recordHeader: { paddingTop: 12, paddingLeft: 14, paddingRight: 12, paddingBottom: 6, minHeight: 62 },
	content: { paddingHorizontal: space.page, width: '100%', maxWidth: space.maxContentWidth, alignSelf: 'center' },
	crumb: { minHeight: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, paddingRight: 4 },
	crumbText: { fontSize: 12, color: colors.muted, fontWeight: '600' },
	backText: { fontSize: type.body, color: colors.heading, fontWeight: '600' },
	titleBox: { flexShrink: 1, minWidth: 0, paddingLeft: 2, justifyContent: 'center', minHeight: 44 },
	headerTitle: { fontFamily: faces.display, fontSize: type.heading, lineHeight: type.headingLine, color: colors.heading },
	organisation: { fontSize: type.tiny, lineHeight: 13, color: colors.muted },
	actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
	round: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
	avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.sage, alignItems: 'center', justifyContent: 'center' },
	avatarLarge: { width: 36, height: 36, borderRadius: 18 },
	avatarText: { fontSize: 10, fontWeight: '700', color: colors.sageText },
	avatarTextLarge: { fontSize: 12, fontWeight: '700' },
	heading: { fontFamily: faces.display, fontSize: type.heading, lineHeight: type.headingLine, color: colors.heading, marginTop: 2, marginBottom: 12 },
	pageHeading: { fontFamily: faces.display, fontSize: type.pageHeading, lineHeight: type.pageHeadingLine, color: colors.heading, marginTop: 0, marginBottom: 2 },
	plain: { fontSize: type.body, lineHeight: type.bodyLine, color: colors.plain }
}));
