import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DataState } from './model.ts';
export const colours = { paper: '#f3ecdf', ink: '#243c2d', green: '#197334', line: '#d9d0bf', pale: '#e5eddd', white: '#fffdf7' };
export const styles = StyleSheet.create({
  button: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center', borderRadius: 12,
    backgroundColor: colours.white, borderColor: colours.line, borderWidth: 1 },
  buttonText: { color: colours.ink, fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  small: { fontSize: 11, color: '#58675c', lineHeight: 16 },
  title: { fontSize: 23, fontWeight: '700', color: colours.ink },
  panel: { flex: 1, minWidth: 0, backgroundColor: colours.paper, padding: 14, gap: 10 },
});
export function Button({ label, onPress, selected = false, disabled = false, testID }: {
  label: string; onPress: () => void; selected?: boolean; disabled?: boolean; testID?: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }}
    testID={testID} disabled={disabled} onPress={onPress}
    style={[styles.button, selected && { backgroundColor: colours.pale }, disabled && { opacity: 0.5 }]}>
    <Text style={styles.buttonText}>{label}</Text>
  </Pressable>;
}
export function StateNotice({ state, retry }: { state: DataState; retry: () => void }) {
  const text = {
    ready: '', loading: 'Loading sample records…', empty: 'No sample records. Availability is unknown.',
    failed: 'Sample records could not be loaded. Try again.', disabled: 'This view is unavailable. Request access from an administrator.',
  }[state];
  return <View style={{ padding: 24, gap: 12 }} accessibilityLiveRegion="polite">
    <Text style={{ color: colours.ink }}>{text}</Text>
    {state === 'failed' && <Button label="Try again" onPress={retry} />}
  </View>;
}
