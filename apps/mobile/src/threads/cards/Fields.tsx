/** Labelled form controls for the card editors (design boards 1 and 2: captain-history-undo-2026-10-02). On the web each
 *  is the browser's own control (input, select, checkbox), so keyboard, autofill and assistive technology behave as they
 *  do on any form; on iOS and Android a React Native equivalent. Every target is at least 44 points. Presentation only:
 *  the editors own every value and action. */
import { createElement, type ReactNode } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { themedStyles, useTheme } from '../../theme/theme.ts';

const web = Platform.OS === 'web';
/** React Native Web's own system font stack, so the browser's controls match the text around them. */
const systemFont = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export function Field({ label, children, testID, wide = false }: { label: string; children: ReactNode; testID?: string; wide?: boolean }) {
	const styles = useStyles();
	return <View testID={testID} style={[styles.field, wide ? styles.wide : styles.half]}><Text style={styles.label}>{label}</Text>{children}</View>;
}

/** The browser's own control, styled with the theme's tokens. */
function useDomStyle(disabled: boolean) {
	const { colors, scheme } = useTheme();
	return { minHeight: 44, height: 44, width: '100%', boxSizing: 'border-box', border: `1px solid ${colors.line}`, borderRadius: 10, padding: '0 12px',
		background: colors.card, color: colors.heading, fontFamily: systemFont, fontSize: 15, colorScheme: scheme, opacity: disabled ? 0.6 : 1, margin: 0 } as const;
}

export function TextField({ label, value, onChange, disabled = false, testID, placeholder, keyboard, maxLength, wide = true }: {
	label: string; value: string; onChange: (v: string) => void; disabled?: boolean; testID?: string; placeholder?: string; keyboard?: 'decimal-pad' | 'default'; maxLength?: number; wide?: boolean;
}) {
	const styles = useStyles();
	const { colors } = useTheme();
	return <Field label={label} wide={wide}><TextInput testID={testID} aria-label={label} accessibilityLabel={label} value={value} onChangeText={onChange} editable={!disabled}
		aria-disabled={disabled} placeholder={placeholder} placeholderTextColor={colors.muted} keyboardType={keyboard} inputMode={keyboard === 'decimal-pad' ? 'decimal' : undefined}
		maxLength={maxLength} style={[styles.input, disabled && styles.off]} /></Field>;
}

/** A calendar date (`YYYY-MM-DD`) or a clock time (`HH:MM`). */
export function DateTimeField({ label, kind, value, onChange, disabled = false, testID, required = true }: { label: string; kind: 'date' | 'time'; value: string; onChange: (v: string) => void; disabled?: boolean; testID?: string; required?: boolean }) {
	const styles = useStyles();
	const dom = useDomStyle(disabled);
	const { colors } = useTheme();
	if (web) return <Field label={label}>{createElement('input', { type: kind, 'data-testid': testID, 'aria-label': label, value, disabled, required, style: dom,
		onChange: (e: { target: { value: string } }) => onChange(e.target.value) })}</Field>;
	return <Field label={label}><TextInput testID={testID} accessibilityLabel={label} value={value} onChangeText={onChange} editable={!disabled} placeholder={kind === 'date' ? 'YYYY-MM-DD' : 'HH:MM'}
		placeholderTextColor={colors.muted} style={[styles.input, disabled && styles.off]} /></Field>;
}

export type Option = { value: string; label: string };
export function SelectField({ label, value, options, onChange, disabled = false, testID, wide = false }: { label: string; value: string; options: readonly Option[]; onChange: (v: string) => void; disabled?: boolean; testID?: string; wide?: boolean }) {
	const styles = useStyles();
	const dom = useDomStyle(disabled);
	if (web) return <Field label={label} wide={wide}>{createElement('select', { 'data-testid': testID, 'aria-label': label, value, disabled, style: dom,
		onChange: (e: { target: { value: string } }) => onChange(e.target.value) }, options.map((o) => createElement('option', { key: o.value, value: o.value }, o.label)))}</Field>;
	return <Field label={label} wide={wide}><View role="radiogroup" aria-label={label} style={styles.choices}>{options.map((o) =>
		<Pressable key={o.value} testID={testID ? `${testID}-${o.value}` : undefined} role="radio" aria-checked={o.value === value} aria-disabled={disabled} disabled={disabled}
			onPress={() => onChange(o.value)} style={[styles.choice, o.value === value && styles.choiceOn]}><Text style={[styles.choiceText, o.value === value && styles.choiceTextOn]}>{o.label}</Text></Pressable>)}</View></Field>;
}

/** Status (design board 1): three buttons, one pressed. */
export function Segmented({ label, value, options, onChange, disabled = false, testID }: { label: string; value: string; options: readonly Option[]; onChange: (v: string) => void; disabled?: boolean; testID?: string }) {
	const styles = useStyles();
	return <Field label={label} wide><View role="group" aria-label={label} style={styles.seg}>{options.map((o, i) =>
		<Pressable key={o.value} testID={testID ? `${testID}-${o.value}` : undefined} role="button" aria-pressed={o.value === value} aria-disabled={disabled} disabled={disabled}
			onPress={() => onChange(o.value)} style={[styles.segItem, i > 0 && styles.segLine, o.value === value && styles.segOn, disabled && styles.off]}>
			<Text numberOfLines={1} style={[styles.segText, o.value === value && styles.segTextOn]}>{o.label}</Text></Pressable>)}</View></Field>;
}

/** A step (design board 1): a real checkbox with its title as the label. */
export function Check({ label, checked, onChange, disabled = false, testID, after }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; testID?: string; after?: ReactNode }) {
	const styles = useStyles();
	const { colors } = useTheme();
	if (web) return <View style={styles.step}>{createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, flex: 1, minWidth: 0, cursor: disabled ? 'default' : 'pointer', color: colors.heading, fontSize: 15, fontFamily: systemFont } },
		createElement('input', { type: 'checkbox', 'data-testid': testID, checked, disabled, onChange: (e: { target: { checked: boolean } }) => onChange(e.target.checked),
			style: { width: 20, height: 20, margin: 0, accentColor: colors.action, flex: 'none' } }), createElement('span', { style: { overflowWrap: 'anywhere' } }, label))}{after}</View>;
	return <View style={styles.step}><Pressable testID={testID} role="checkbox" aria-checked={checked} aria-label={label} aria-disabled={disabled} disabled={disabled} onPress={() => onChange(!checked)} style={styles.checkRow}>
		<View aria-hidden style={[styles.box, checked && styles.boxOn]}>{checked ? <Text style={styles.tick}>✓</Text> : null}</View><Text style={styles.stepText}>{label}</Text></Pressable>{after}</View>;
}

/** `start`: a choice written as a sentence, left-aligned (design board 8). `offNeutral`: a disabled primary drawn in the
 *  neutral pair rather than faded (boards 8 and 9). */
export function CardButton({ label, onPress, primary = false, quiet = false, warn = false, disabled = false, testID, grow = false, display, start = false, offNeutral = false }: {
	label: string; onPress: () => void; primary?: boolean; quiet?: boolean; warn?: boolean; disabled?: boolean; testID?: string; grow?: boolean; display?: string; start?: boolean; offNeutral?: boolean;
}) {
	const styles = useStyles();
	const neutral = offNeutral && disabled && primary;
	return <Pressable testID={testID} role="button" aria-label={label} aria-disabled={disabled} disabled={disabled} onPress={disabled ? undefined : onPress}
		style={[styles.button, primary && !neutral && styles.primary, neutral && styles.neutralOff, quiet && styles.quiet, grow && styles.grow, start && styles.start, disabled && !neutral && styles.off]}>
		<Text style={[styles.buttonText, primary && !neutral && styles.primaryText, neutral && styles.neutralOffText, quiet && styles.quietText, warn && styles.warnText, start && styles.startText]}>{display ?? label}</Text></Pressable>;
}

/** An occupancy, overlap or status note (design board 2's `note`). */
export function Note({ tone, children, testID }: { tone: 'ok' | 'warn' | 'neutral'; children: ReactNode; testID?: string }) {
	const styles = useStyles();
	return <View testID={testID} role={tone === 'warn' ? 'alert' : undefined} style={[styles.note, tone === 'ok' ? styles.noteOk : tone === 'warn' ? styles.noteWarn : styles.noteNeutral]}>
		<Text style={tone === 'warn' ? styles.noteWarnText : tone === 'neutral' ? styles.noteNeutralText : styles.noteText}>{children}</Text></View>;
}

export function Muted({ children, testID }: { children: ReactNode; testID?: string }) {
	const styles = useStyles();
	return <Text testID={testID} style={styles.muted}>{children}</Text>;
}

const useStyles = themedStyles((colors) => ({
	field: { gap: 4, minWidth: 0 },
	half: { flexBasis: '45%', flexGrow: 1 },
	wide: { width: '100%' },
	label: { fontSize: 12, color: colors.muted },
	input: { minHeight: 44, borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: colors.card, paddingHorizontal: 12, fontSize: 15, color: colors.heading, width: '100%' },
	off: { opacity: 0.6 },
	choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
	choice: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: colors.card },
	choiceOn: { backgroundColor: colors.action, borderColor: colors.action },
	choiceText: { fontSize: 14, color: colors.body },
	choiceTextOn: { color: colors.actionText, fontWeight: '600' },
	seg: { flexDirection: 'row', borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: 'hidden' },
	segItem: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, paddingHorizontal: 4 },
	segLine: { borderLeftWidth: 1, borderColor: colors.line },
	segOn: { backgroundColor: colors.action },
	segText: { fontSize: 15, color: colors.body },
	segTextOn: { color: colors.actionText, fontWeight: '600' },
	step: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, borderBottomWidth: 1, borderColor: colors.rowLine },
	checkRow: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
	box: { width: 20, height: 20, borderRadius: 4, borderWidth: 1.5, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
	boxOn: { backgroundColor: colors.action, borderColor: colors.action },
	tick: { fontSize: 13, lineHeight: 15, color: colors.actionText, fontWeight: '700' },
	stepText: { flex: 1, fontSize: 15, color: colors.heading },
	button: { minHeight: 44, minWidth: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
	primary: { backgroundColor: colors.action, borderColor: colors.action },
	quiet: { borderWidth: 0, backgroundColor: 'transparent', paddingHorizontal: 0, alignSelf: 'flex-start' },
	grow: { flex: 1 },
	start: { alignItems: 'flex-start', paddingVertical: 10 },
	startText: { textAlign: 'left' },
	neutralOff: { backgroundColor: colors.neutral, borderColor: colors.neutral },
	neutralOffText: { color: colors.neutralText },
	buttonText: { fontSize: 15, fontWeight: '600', color: colors.heading },
	primaryText: { color: colors.actionText },
	quietText: { color: colors.action },
	warnText: { color: colors.warningText },
	note: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1 },
	noteOk: { backgroundColor: colors.needsYou, borderColor: colors.needsYouLine },
	noteWarn: { backgroundColor: colors.warning, borderColor: colors.warningLine },
	noteNeutral: { backgroundColor: colors.neutral, borderColor: colors.neutral },
	noteText: { fontSize: 13, lineHeight: 18, color: colors.body },
	noteWarnText: { fontSize: 13, lineHeight: 18, color: colors.warningText },
	noteNeutralText: { fontSize: 13, lineHeight: 18, color: colors.neutralText },
	muted: { fontSize: 13, lineHeight: 18, color: colors.muted }
}));
