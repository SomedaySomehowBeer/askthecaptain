import { Text, View } from 'react-native';
import { type } from '../theme/tokens.ts';
import { themedStyles } from '../theme/theme.ts';

/** A designed state in words (AGENTS.md "Honest states"): what is true now and what to do next. Never a record. */
export function Notice({ title, children }: { title: string; children: string }) {
	const styles = useStyles();
	return (
		<View style={styles.box} accessible role="summary" aria-label={`${title}. ${children}`}>
			<Text style={styles.title}>{title}</Text>
			<Text style={styles.body}>{children}</Text>
		</View>
	);
}

const useStyles = themedStyles((colors) => ({
	box: { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, paddingVertical: 12, gap: 4, marginBottom: 10 },
	title: { fontSize: type.body, fontWeight: '600', color: colors.heading },
	body: { fontSize: type.small, lineHeight: type.smallLine, color: colors.body }
}));
