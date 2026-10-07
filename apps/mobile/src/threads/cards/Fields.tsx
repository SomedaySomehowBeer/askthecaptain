/** Labelled form controls for the card editors (design boards 1 and 2: captain-history-undo-2026-10-02). On the web each
 *  is the browser's own control (input, select, checkbox), so keyboard, autofill and assistive technology behave as they
 *  do on any form, drawn as the boards' fields (R3 captain.css `.input`): no platform chrome, a drawn chevron on a
 *  select, and a date or time written as people say it ("Thu 8 Oct 2026", "8:00 am") over the browser's own date and
 *  time input, which opens its picker on a tap and shows its own fields while focused (public/index.html holds those
 *  rules). On iOS and Android a React Native equivalent. Every target is at least 44 points. Presentation only: the
 *  editors own every value and action. */
import { createElement, useState, type ReactNode } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { themedStyles, useTheme } from '../../theme/theme.ts';
import { familyFor, type } from '../../theme/tokens.ts';

const web = Platform.OS === 'web';
/** The body face, so the browser's controls match the text around them. */
const textFont = familyFor('regular', true);

/** A calendar date as the boards write it: "Thu 8 Oct 2026". */
export function dateWords(value: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).formatToParts(new Date(`${value}T00:00:00Z`));
	const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
	return `${part('weekday')} ${part('day')} ${part('month')} ${part('year')}`;
}

/** A clock time as the boards write it: "8:00 am", "12:30 pm". */
export function timeWords(value: string): string {
	const m = /^(\d{2}):(\d{2})/.exec(value);
	if (!m) return value;
	const h = Number(m[1]);
	return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

export function Field({ label, children, testID, wide = false }: { label: string; children: ReactNode; testID?: string; wide?: boolean }) {
	const styles = useStyles();
	return <View testID={testID} style={[styles.field, wide ? styles.wide : styles.half]}><Text style={styles.label}>{label}</Text>{children}</View>;
}

/** The browser's own control drawn as the boards' field (R3 `.input`, `.input-focus` through public/index.html's
 *  `.captain-field` rules and these two custom properties). A select gets the boards' chevron. */
function useDomStyle(disabled: boolean, select = false) {
	const { colors, scheme } = useTheme();
	const chevron = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1.5l5 5 5-5' fill='none' stroke='${colors.heading}' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/></svg>`)}")`;
	return { minHeight: 44, height: 44, width: '100%', boxSizing: 'border-box', border: `1px solid ${colors.fieldLine}`, borderRadius: 10, padding: select ? '0 34px 0 12px' : '0 12px',
		background: select ? `${colors.card} ${chevron} no-repeat right 14px center` : colors.card, color: colors.heading, fontFamily: textFont, fontSize: type.body,
		colorScheme: scheme, opacity: disabled ? 0.6 : 1, margin: 0, appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', textOverflow: 'ellipsis',
		'--captain-focus': colors.action, '--captain-ring': colors.sage } as const;
}

export function TextField({ label, value, onChange, disabled = false, testID, placeholder, keyboard, maxLength, wide = true }: {
	label: string; value: string; onChange: (v: string) => void; disabled?: boolean; testID?: string; placeholder?: string; keyboard?: 'decimal-pad' | 'default'; maxLength?: number; wide?: boolean;
}) {
	const styles = useStyles();
	const { colors } = useTheme();
	const [focused, setFocused] = useState(false);
	return <Field label={label} wide={wide}><TextInput testID={testID} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} aria-label={label} accessibilityLabel={label} value={value} onChangeText={onChange} editable={!disabled}
		aria-disabled={disabled} placeholder={placeholder} placeholderTextColor={colors.muted} keyboardType={keyboard} inputMode={keyboard === 'decimal-pad' ? 'decimal' : undefined}
		maxLength={maxLength} style={[styles.input, focused && styles.focused, disabled && styles.off]} /></Field>;
}

/** A calendar date (`YYYY-MM-DD`) or a clock time (`HH:MM`). */
export function DateTimeField({ label, kind, value, onChange, disabled = false, testID, required = true }: { label: string; kind: 'date' | 'time'; value: string; onChange: (v: string) => void; disabled?: boolean; testID?: string; required?: boolean }) {
	const styles = useStyles();
	const dom = useDomStyle(disabled);
	const { colors } = useTheme();
	if (web) {
		const shown = value ? (kind === 'date' ? dateWords(value) : timeWords(value)) : (kind === 'date' ? 'Choose a date' : 'Choose a time');
		return <Field label={label}>{createElement('div', { style: { position: 'relative', width: '100%' } },
			createElement('input', { type: kind, className: 'captain-field captain-when', 'data-testid': testID, 'aria-label': label, value, disabled, required, style: dom,
				onChange: (e: { target: { value: string } }) => onChange(e.target.value) }),
			createElement('div', { className: 'captain-when-text', 'aria-hidden': true, style: { position: 'absolute', left: 1, right: 1, top: 1, bottom: 1, display: 'flex', alignItems: 'center',
				padding: '0 11px', pointerEvents: 'none', color: value ? colors.heading : colors.muted, fontFamily: textFont, fontSize: type.body, opacity: disabled ? 0.6 : 1,
				whiteSpace: 'nowrap', overflow: 'hidden' } }, shown))}</Field>;
	}
	return <Field label={label}><TextInput testID={testID} accessibilityLabel={label} value={value} onChangeText={onChange} editable={!disabled} placeholder={kind === 'date' ? 'YYYY-MM-DD' : 'HH:MM'}
		placeholderTextColor={colors.muted} style={[styles.input, disabled && styles.off]} /></Field>;
}

export type Option = { value: string; label: string };
export function SelectField({ label, value, options, onChange, disabled = false, testID, wide = false }: { label: string; value: string; options: readonly Option[]; onChange: (v: string) => void; disabled?: boolean; testID?: string; wide?: boolean }) {
	const styles = useStyles();
	const dom = useDomStyle(disabled, true);
	if (web) return <Field label={label} wide={wide}>{createElement('select', { className: 'captain-field', 'data-testid': testID, 'aria-label': label, value, disabled, style: dom,
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
	if (web) return <View style={styles.step}>{createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, flex: 1, minWidth: 0, cursor: disabled ? 'default' : 'pointer', color: colors.heading, fontSize: type.body, fontFamily: textFont } },
		createElement('input', { type: 'checkbox', 'data-testid': testID, checked, disabled, onChange: (e: { target: { checked: boolean } }) => onChange(e.target.checked),
			style: { width: 20, height: 20, margin: 0, accentColor: colors.action, flex: 'none' } }), createElement('span', { style: { overflowWrap: 'anywhere' } }, label))}{after}</View>;
	return <View style={styles.step}><Pressable testID={testID} role="checkbox" aria-checked={checked} aria-label={label} aria-disabled={disabled} disabled={disabled} onPress={() => onChange(!checked)} style={styles.checkRow}>
		<View aria-hidden style={[styles.box, checked && styles.boxOn]}>{checked ? <Text style={styles.tick}>✓</Text> : null}</View><Text style={styles.stepText}>{label}</Text></Pressable>{after}</View>;
}

/** `start`: a choice written as a sentence, left-aligned (design board 8). `offNeutral`: a disabled primary drawn in the
 *  neutral pair rather than faded (boards 8 and 9). */
export function CardButton({ label, onPress, primary = false, quiet = false, warn = false, disabled = false, testID, grow = false, display, start = false, offNeutral = false, link = false }: {
	label: string; onPress: () => void; primary?: boolean; quiet?: boolean; warn?: boolean; disabled?: boolean; testID?: string; grow?: boolean; display?: string; start?: boolean; offNeutral?: boolean;
	/** A quiet action drawn as the boards' underlined link (R3 `.link`: the card's "History"). */
	link?: boolean;
}) {
	const styles = useStyles();
	// A disabled primary is the boards' neutral `.btn-off` (boards 1, 8 and 9), never a faded green.
	const neutral = (offNeutral || primary) && disabled && primary;
	return <Pressable testID={testID} role="button" aria-label={label} aria-disabled={disabled} disabled={disabled} onPress={disabled ? undefined : onPress}
		style={[styles.button, primary && !neutral && styles.primary, neutral && styles.neutralOff, quiet && styles.quiet, grow && styles.grow, start && styles.start, disabled && !neutral && styles.off]}>
		<Text style={[styles.buttonText, primary && !neutral && styles.primaryText, neutral && styles.neutralOffText, quiet && styles.quietText, link && styles.linkText, warn && styles.warnText, start && styles.startText]}>{display ?? label}</Text></Pressable>;
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

/** R3 captain.css `.field`, `.input`, `.seg`, `.step`, `.btn`, `.btn-primary`, `.btn-off`, `.btn-quiet`, `.note`. */
const useStyles = themedStyles((colors) => ({
	field: { gap: 4, minWidth: 0 },
	half: { flexBasis: '45%', flexGrow: 1 },
	wide: { width: '100%' },
	label: { fontSize: type.label, color: colors.muted },
	input: { minHeight: 44, borderWidth: 1, borderColor: colors.fieldLine, borderRadius: 10, backgroundColor: colors.card, paddingHorizontal: 12, fontSize: type.body, color: colors.heading, width: '100%', outlineWidth: 0 },
	// R3 `.input-focus`: the action border and a sage ring, in place of the browser's outline.
	focused: { borderColor: colors.action, boxShadow: `0 0 0 2px ${colors.sage}`, outlineWidth: 0 },
	off: { opacity: 0.6 },
	choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
	choice: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderWidth: 1, borderColor: colors.fieldLine, borderRadius: 10, backgroundColor: colors.card },
	choiceOn: { backgroundColor: colors.action, borderColor: colors.action },
	choiceText: { fontSize: type.body, color: colors.body },
	choiceTextOn: { color: colors.actionText, fontWeight: '600' },
	seg: { flexDirection: 'row', borderWidth: 1, borderColor: colors.fieldLine, borderRadius: 10, overflow: 'hidden' },
	segItem: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, paddingHorizontal: 4 },
	segLine: { borderLeftWidth: 1, borderColor: colors.fieldLine },
	segOn: { backgroundColor: colors.action },
	segText: { fontSize: type.body, color: colors.body },
	segTextOn: { color: colors.actionText, fontWeight: '600' },
	step: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, borderBottomWidth: 1, borderColor: colors.rowLine },
	checkRow: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
	box: { width: 20, height: 20, borderRadius: 4, borderWidth: 1.5, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
	boxOn: { backgroundColor: colors.action, borderColor: colors.action },
	tick: { fontSize: 13, lineHeight: 15, color: colors.actionText, fontWeight: '700' },
	stepText: { flex: 1, fontSize: type.body, color: colors.heading },
	button: { minHeight: 44, minWidth: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.fieldLine, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
	primary: { backgroundColor: colors.action, borderColor: colors.action },
	quiet: { borderWidth: 0, backgroundColor: 'transparent', paddingHorizontal: 0, alignSelf: 'flex-start' },
	grow: { flex: 1 },
	start: { alignItems: 'flex-start', paddingVertical: 10 },
	startText: { textAlign: 'left' },
	neutralOff: { backgroundColor: colors.neutral, borderColor: colors.neutral },
	neutralOffText: { color: colors.neutralText },
	buttonText: { fontSize: type.button, fontWeight: '600', color: colors.heading },
	primaryText: { color: colors.actionText },
	quietText: { color: colors.action },
	linkText: { textDecorationLine: 'underline' },
	warnText: { color: colors.warningText },
	note: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1 },
	noteOk: { backgroundColor: colors.needsYou, borderColor: colors.needsYouLine },
	noteWarn: { backgroundColor: colors.warning, borderColor: colors.warningLine },
	noteNeutral: { backgroundColor: colors.neutral, borderColor: colors.neutral },
	noteText: { fontSize: type.small, lineHeight: type.smallLine, color: colors.body },
	noteWarnText: { fontSize: type.small, lineHeight: type.smallLine, color: colors.warningText },
	noteNeutralText: { fontSize: type.small, lineHeight: type.smallLine, color: colors.neutralText },
	muted: { fontSize: type.small, lineHeight: type.smallLine, color: colors.muted }
}));
