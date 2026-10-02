/** One change line in a thread (design board 4, Lines.dc.html): worded by code from its changes, with the actor's
 *  first name and the time. It has no menu. It is focusable and tappable; until History exists (V-E) a tap does nothing
 *  more than the full wording its label gives assistive technology. V-E links it through `historyRoute`. */
import { Pressable, Text, View } from 'react-native';
import type { Message } from './contracts.ts';
import { wordChangeLine, type WordingOptions } from './wording.ts';
import { themedStyles } from '../theme/theme.ts';

/** The seam for V-E: the History screen for a change set, `/threads/[id]/history`. Nothing to open until it exists. */
export function historyRoute(_threadId: string, _changeSetId: string): string | null { return null; }

export function ChangeLine({ message, options, onOpen }: { message: Message; options: WordingOptions; onOpen?: (route: string) => void }) {
	const styles = useStyles();
	const { segments, text } = wordChangeLine(message.change!, options);
	const time = new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	const route = message.changeSetId ? historyRoute(message.threadId, message.changeSetId) : null;
	return <Pressable testID={`change-line-${message.id}`} focusable accessible aria-label={`${text}, ${time}`} onPress={route && onOpen ? () => onOpen(route) : undefined} style={styles.line}>
		<Text aria-hidden style={styles.icon}>✎</Text>
		<View style={styles.textBox}><Text style={styles.text}>{segments.map((s, i) => s.strong ? <Text key={i} style={styles.strong}>{s.text}</Text> : s.text)}<Text> · {time}</Text></Text></View>
	</Pressable>;
}

const useStyles = themedStyles((colors) => ({
	line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, minHeight: 44, paddingVertical: 9, paddingLeft: 36 },
	icon: { fontSize: 13, lineHeight: 18, color: colors.muted, width: 14 },
	textBox: { flex: 1, minWidth: 0, borderBottomWidth: 0 },
	text: { fontSize: 13, lineHeight: 18, color: colors.muted },
	strong: { color: colors.body, fontWeight: '600' }
}));
