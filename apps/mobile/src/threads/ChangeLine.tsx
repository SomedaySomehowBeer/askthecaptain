/** One change line in a thread (design board 4, Lines.dc.html): worded by code from its changes, with the actor's
 *  first name and the time. It has no menu. It is a link: a tap opens History at its change set (R3 V-E).
 *  A run of consecutive lines folds to one `FoldedRun` line (owner decision, 3 October 2026); a tap unfolds it in place. */
import { Pressable, Text, View } from 'react-native';
import type { Message } from './contracts.ts';
import { unfoldLabel, wordChangeLine, wordFoldedRun, wordSpan, type WordingOptions } from './wording.ts';
import { historyRoute } from './history/route.ts';
import { themedStyles, useTheme } from '../theme/theme.ts';
import { type } from '../theme/tokens.ts';
import { Pencil } from '../components/Icons.tsx';
import { clockTime } from './Presentation.tsx';

export { historyRoute } from './history/route.ts';

export function ChangeLine({ message, options, onOpen }: { message: Message; options: WordingOptions; onOpen?: (route: string) => void }) {
	const styles = useStyles();
	const { colors } = useTheme();
	const { segments, text } = wordChangeLine(message.change!, options);
	const time = clock(message.createdAt);
	const route = message.changeSetId ? historyRoute(message.threadId, message.changeSetId) : null;
	return <Pressable testID={`change-line-${message.id}`} focusable accessible role={route && onOpen ? 'link' : undefined} aria-label={`${text}, ${time}${route && onOpen ? '. Opens History' : ''}`} onPress={route && onOpen ? () => onOpen(route) : undefined} style={styles.line}>
		<View style={styles.icon}><Pencil color={colors.muted} /></View>
		<View style={styles.textBox}><Text style={styles.text}>{segments.map((s, i) => s.strong ? <Text key={i} style={styles.strong}>{s.text}</Text> : s.text)}<Text> · {time}</Text></Text></View>
	</Pressable>;
}

const clock = clockTime;

/** A folded run: the newest line in full, "and N earlier changes", the actors when several, and the newest time or the
 *  dates the run spans. A real button; a tap shows every line of the run where it stands. */
export function FoldedRun({ lines, options, onUnfold }: { lines: readonly Message[]; options: WordingOptions; onUnfold: () => void }) {
	const styles = useStyles();
	const { colors } = useTheme();
	const { segments, text } = wordFoldedRun(lines.map((m) => m.change!), options);
	const first = lines[0]!, newest = lines.at(-1)!;
	const when = wordSpan(first.createdAt, newest.createdAt, options.year) ?? clock(newest.createdAt);
	return <Pressable testID={`change-run-${first.id}`} focusable accessible role="button" aria-expanded={false} aria-label={`${text}, ${when}. ${unfoldLabel(lines.length)}`} onPress={onUnfold} style={styles.line}>
		<View style={styles.icon}><Pencil color={colors.muted} /></View>
		<View style={styles.textBox}><Text style={styles.text}>{segments.map((s, i) => s.strong ? <Text key={i} style={styles.strong}>{s.text}</Text> : s.text)}<Text> · {when}</Text></Text></View>
	</Pressable>;
}

/** R3 Lines `.change`: 54 pt in from the thread's edge, a pencil, 13 pt muted words with the values in 600 body. */
const useStyles = themedStyles((colors) => ({
	line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, minHeight: 44, paddingVertical: 9, paddingLeft: 38 },
	icon: { width: 14, paddingTop: 2 },
	textBox: { flex: 1, minWidth: 0, borderBottomWidth: 0 },
	text: { fontSize: type.small, lineHeight: type.smallLine, color: colors.muted },
	strong: { color: colors.body, fontWeight: '600' }
}));
