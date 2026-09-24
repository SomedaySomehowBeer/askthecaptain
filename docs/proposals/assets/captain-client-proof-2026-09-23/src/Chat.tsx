import React, { useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { dateTime, messages as initialMessages } from './fixtures.ts';
import { mergeMessages, pinnedMessages, recentMessages, type Message } from './model.ts';
import { Button, colours, styles } from './ui.tsx';
export function Chat() {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState('');
  const [inline, setInline] = useState(false);
  const [limit, setLimit] = useState(40);
  const [notice, setNotice] = useState('');
  const list = useRef<FlatList<Message>>(null);
  const atBottom = useRef(true), showStart = useRef(false), sequence = useRef(0);
  const visible = messages.slice(-limit);
  const addLocalMessage = () => {
    if (!draft.trim()) return;
    const id = `local-${++sequence.current}`;
    const message: Message = { id, author: 'You', text: draft.trim(), at: messages.at(-1)!.at + 60_000, pinned: false };
    setMessages(current => mergeMessages(current, [message]));
    setLimit(current => current + 1); setDraft('');
    atBottom.current = true; setNotice('Added in this preview only. Reload clears it; nothing was sent.');
  };
  const row = ({ item, index }: { item: Message; index: number }) => <View testID={`chat-${item.id}`}
    style={[local.message, index % 2 === 0 && { backgroundColor: 'rgba(255,255,255,0.35)' }]}>
    <View style={local.avatar}><Text style={{ fontSize: 10, color: colours.ink }}>{item.author.split(' ').map(s => s[0]).join('')}</Text></View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={styles.row}><Text style={{ fontSize: 12, fontWeight: '700', color: colours.ink }}>{item.author}</Text><Text style={styles.small}>{dateTime(item.at)}</Text></View>
      <Text style={{ fontSize: 13, lineHeight: 19, color: colours.ink }}>{item.text}</Text>
    </View>
  </View>;
  const pins = <View style={local.pins} testID="shared-pins">
    <Text style={{ fontSize: 11, fontWeight: '700', color: '#796038' }}>Pinned for everyone</Text>
    {pinnedMessages(messages).map(m => <View key={m.id}><Text style={{ fontSize: 12, color: colours.ink }}>{m.author}: {m.text}</Text>
      <Text style={styles.small}>Source {m.id} · shared fixture reference</Text></View>)}
  </View>;
  return <KeyboardAvoidingView style={styles.panel} behavior={Platform.OS === 'ios' ? 'padding' : undefined} testID="chat-panel">
    <Text style={styles.title}># Packaging slot</Text>
    <Text style={styles.small}>Summer lager launch · {messages.length} fictional messages</Text>
    <View style={styles.row}><Button label="Full chat" selected={!inline} onPress={() => { setInline(false); atBottom.current = true; }} />
      <Button label="On the task" selected={inline} onPress={() => setInline(true)} /></View>
    {inline ? <ScrollView style={{ flex: 1 }} testID="inline-chat"><Text style={styles.small}>Task: Package Summer lager · same conversation</Text>
      {pins}<Text style={styles.small}>Latest 6 of {messages.length} messages</Text>
      {recentMessages(messages).map((item, index) => <React.Fragment key={item.id}>{row({ item, index })}</React.Fragment>)}
    </ScrollView> : <>
      {pins}
      <FlatList ref={list} data={visible} keyExtractor={m => m.id} renderItem={row}
        style={{ flex: 1 }} testID="message-list" keyboardShouldPersistTaps="handled"
        initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7}
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        ListHeaderComponent={limit < messages.length ? <Button label="Load older messages" onPress={() => {
          atBottom.current = false; showStart.current = true; setLimit(current => current + 40);
          setNotice('Loaded earlier local history. Scroll to continue reading.');
        }} /> : <Text style={styles.small}>Start of sample conversation</Text>}
        onScroll={event => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 40; }} scrollEventThrottle={32}
        onContentSizeChange={() => {
          if (showStart.current) { showStart.current = false; return; }
          if (atBottom.current) requestAnimationFrame(() => list.current?.scrollToEnd({ animated: false }));
        }} />
      <Button label="Latest messages" onPress={() => { atBottom.current = true; list.current?.scrollToEnd({ animated: false }); }} />
    </>}
    {notice ? <Text style={styles.small} accessibilityLiveRegion="polite" testID="chat-notice">{notice}</Text> : null}
    <View style={local.composer} testID="composer">
      <TextInput value={draft} onChangeText={setDraft} multiline accessibilityLabel="Message draft" placeholder="Message packaging slot…"
        style={{ color: colours.ink, fontSize: 13, minHeight: 42, maxHeight: 100 }} />
      <Button label="Add local message" disabled={!draft.trim()} onPress={addLocalMessage} />
    </View>
  </KeyboardAvoidingView>;
}
const local = StyleSheet.create({
  message: { flexDirection: 'row', gap: 9, padding: 9 },
  avatar: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#dbe6d4', justifyContent: 'center', alignItems: 'center' },
  pins: { padding: 10, gap: 6, backgroundColor: '#eeeadc', borderWidth: 1, borderColor: colours.line, borderRadius: 12, marginVertical: 8 },
  composer: { padding: 10, gap: 6, borderWidth: 1, borderColor: colours.line, borderRadius: 14, backgroundColor: colours.white },
});
