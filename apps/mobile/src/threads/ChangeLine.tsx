/** One change line in a thread (design board 4, Lines.dc.html): worded by code from its changes, with the actor's
 *  first name and the time. It has no menu. It is a link: a tap opens History at its change set (R3 V-E).
 *  A run of consecutive lines folds to one `FoldedRun` line (owner decision, 3 October 2026); a tap unfolds it in place. */
import { Pressable, Text, View } from 'react-native';
import type { Message } from './contracts.ts';
import { unfoldLabel, wordChangeLine, wordFoldedRun, wordSpan, type WordingOptions } from './wording.ts';
import { historyRoute } from './history/route.ts';
import { themedStyles } from '../theme/theme.ts';

export { historyRoute } from './history/route.ts';

export function ChangeLine({ message, options, onOpen }: { message: Message; options: WordingOptions; onOpen?: (route: string) => void }) {
	const styles = useStyles();
	const { segments, text } = wordChangeLine(message.change!, options);
	const time = clock(message.createdAt);
	const route = message.changeSetId ? historyRoute(message.threadId, message.changeSetId) : null;
	return <Pressable testID={`change-line-${message.id}`} focusable accessible role={route && onOpen ? 'link' : undefined} aria-label={`${text}, ${time}${route && onOpen ? '. Opens History' : ''}`} onPress={route && onOpen ? () => onOpen(route) : undefined} style={styles.line}>
		<Text aria-hidden style={styles.icon}>✎</Text>
		<View style={styles.textBox}><Text style={styles.text}>{segments.map((s, i) => s.strong ? <Text key={i} style={styles.strong}>{s.text}</Text> : s.text)}<Text> · {time}</Text></Text></View>
	</Pressable>;
}

const clock = (instant: string) => new Date(instant).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** A folded run: the newest line in full, "and N earlier changes", the actors when several, and the newest time or the
 *  dates the run spans. A real button; a tap shows every line of the run where it stands. */
export function FoldedRun({ lines, options, onUnfold }: { lines: readonly Message[]; options: WordingOptions; onUnfold: () => void }) {
	const styles = useStyles();
	const { segments, text } = wordFoldedRun(lines.map((m) => m.change!), options);
	const first = lines[0]!, newest = lines.at(-1)!;
	const when = wordSpan(first.createdAt, newest.createdAt, options.year) ?? clock(newest.createdAt);
	return <Pressable testID={`change-run-${first.id}`} focusable accessible role="button" aria-expanded={false} aria-label={`${text}, ${when}. ${unfoldLabel(lines.length)}`} onPress={onUnfold} style={styles.line}>
		<Text aria-hidden style={styles.icon}>✎</Text>
		<View style={styles.textBox}><Text style={styles.text}>{segments.map((s, i) => s.strong ? <Text key={i} style={styles.strong}>{s.text}</Text> : s.text)}<Text> · {when}</Text></Text></View>
	</Pressable>;
}

const useStyles = themedStyles((colors) => ({
	line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, minHeight: 44, paddingVertical: 9, paddingLeft: 36 },
	icon: { fontSize: 13, lineHeight: 18, color: colors.muted, width: 14 },
	textBox: { flex: 1, minWidth: 0, borderBottomWidth: 0 },
	text: { fontSize: 13, lineHeight: 18, color: colors.muted },
	strong: { color: colors.body, fontWeight: '600' }
}));
