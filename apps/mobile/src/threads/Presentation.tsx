/** Presentation only: existing callers own every action, disabled state and request. */
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, type TextInputProps } from 'react-native';
import type { RecordKind } from './contracts.ts';
import { themedStyles, useTheme } from '../theme/theme.ts';

type ActionProps = {
 label: string;
 onPress: () => void;
 disabled?: boolean;
 primary?: boolean;
 testID?: string;
 dashed?: boolean;
 display?: string;
};

export function ThreadAction({ label, onPress, disabled = false, primary = false, testID, display, dashed = false }: ActionProps) {
 const styles = useStyles();
 return <Pressable testID={testID} role="button" aria-label={label} aria-disabled={disabled}
  disabled={disabled} onPress={disabled ? undefined : onPress}
  style={[styles.action, primary && styles.primary, dashed && styles.dashed]}>
  <Text style={[styles.actionText, primary && styles.primaryText,
   !primary && disabled && styles.disabledText]}>{display ?? label}</Text>
 </Pressable>;
}

export function ComposerInput(props: TextInputProps) {
 const styles = useStyles();
 const { colors } = useTheme();
 const [height, setHeight] = useState(44);
 useEffect(() => { if (!props.value) setHeight(44); }, [props.value]);
 return <TextInput {...props} multiline placeholderTextColor={colors.muted}
  onContentSizeChange={event => setHeight(Math.max(44, Math.min(120, event.nativeEvent.contentSize.height)))}
  style={[styles.input, { height }, props.style]} />;
}

/** Tag boundaries are calendar dates: do not shift them with the device's timezone. */
export function groupDates(start?: string | null, end?: string | null) {
 const date = (s: string) => new Date(`${s}T00:00:00Z`);
 const format = (s: string, year = false) => new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', ...(year ? { year: 'numeric' as const } : {}), timeZone: 'UTC'
 }).format(date(s));
 if (start && end) {
  if (start === end) return format(start);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${date(start).getUTCDate()}–${format(end)}`;
  const year = start.slice(0, 4) !== end.slice(0, 4);
  return `${format(start, year)} – ${format(end, year)}`;
 }
 return start ? `From ${format(start)}` : end ? `Until ${format(end)}` : '';
}

export function factLabels(kind?: RecordKind): readonly [string,string] {
 switch(kind) {
  case 'task': return ['Owner','Due'];
  case 'booking': return ['Equipment','Start'];
  case 'stock': return ['Count','Counted'];
  default: return ['Started by','People'];
 }
}
export function initials(name: string | null) {
 const words=name?.trim().split(/\s+/).filter(Boolean)??[];
 return words.length ? [words[0]!,...(words.length>1?[words.at(-1)!]:[])].map(word=>Array.from(word)[0]).join('').toLocaleUpperCase() : '–';
}
/** Message days follow the same device timezone as their displayed times. */
export function messageDay(instant:string) {
 return new Date(instant).toDateString();
}
export function dayLabel(instant:string) {
 return new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long'}).format(new Date(instant));
}

const useStyles = themedStyles((colors) => ({
 action: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start', borderRadius: 10 },
 actionText: { fontSize: 13, fontWeight: '600', color: colors.action },
 primary: { backgroundColor: colors.action, paddingHorizontal: 12 },
 primaryText: { color: colors.actionText },
 dashed: { alignSelf: 'stretch', borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line },
 disabledText: { color: colors.muted },
 input: { flex: 1, minWidth: 0, color: colors.body, fontSize: 15, lineHeight: 21, paddingHorizontal: 10, paddingVertical: 11, minHeight: 44, maxHeight: 120, textAlignVertical: 'top' }
}));
