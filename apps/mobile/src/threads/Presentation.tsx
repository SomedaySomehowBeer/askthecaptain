/** Presentation only: existing callers own every action, disabled state and request. */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, type TextInputProps } from 'react-native';
import { colors } from '../theme/tokens.ts';

type ActionProps = {
 label: string;
 onPress: () => void;
 disabled?: boolean;
 primary?: boolean;
 testID?: string;
 display?: string;
};

export function ThreadAction({ label, onPress, disabled = false, primary = false, testID, display }: ActionProps) {
 return <Pressable testID={testID} role="button" aria-label={label} aria-disabled={disabled}
  disabled={disabled} onPress={disabled ? undefined : onPress}
  style={[styles.action, primary && styles.primary, primary && disabled && styles.disabledPrimary]}>
  <Text style={[styles.actionText, primary && styles.primaryText,
   disabled && (primary ? styles.disabledPrimaryText : styles.disabledText)]}>{display ?? label}</Text>
 </Pressable>;
}

export function ComposerInput(props: TextInputProps) {
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

const styles = StyleSheet.create({
 action: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start', borderRadius: 10 },
 actionText: { fontSize: 13, fontWeight: '600', color: colors.action },
 primary: { backgroundColor: colors.action, paddingHorizontal: 12 },
 primaryText: { color: colors.actionText },
 disabledPrimary: { backgroundColor: colors.sage },
 disabledPrimaryText: { color: colors.body },
 disabledText: { color: colors.muted },
 input: { flex: 1, minWidth: 0, color: colors.body, fontSize: 15, lineHeight: 21, paddingHorizontal: 10, paddingVertical: 11, minHeight: 44, maxHeight: 120, textAlignVertical: 'top' }
});
