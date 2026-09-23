import React, { useState } from 'react';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Timeline } from './Timeline.tsx';
import { Chat } from './Chat.tsx';
import { Button, colours, StateNotice, styles } from './ui.tsx';
import type { DataState } from './model.ts';
export default function App() {
  const { width } = useWindowDimensions();
  const [screen, setScreen] = useState<'timeline' | 'chat'>('timeline');
  const [state, setState] = useState<DataState>('ready');
  const wide = width >= 1000;
  return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: colours.paper }}>
    <View style={{ padding: 12, gap: 8, borderBottomWidth: 1, borderColor: colours.line }}>
      <Text style={{ color: colours.ink, fontSize: 13, fontWeight: '700' }}>Captain · client architecture proof</Text>
      <Text style={styles.small}>Fictional data · local interactions only · not the production app</Text>
      <ScrollView horizontal contentContainerStyle={{ gap: 6 }}>
        {!wide && <><Button label="Timeline" selected={screen === 'timeline'} onPress={() => setScreen('timeline')} />
          <Button label="Chat" selected={screen === 'chat'} onPress={() => setScreen('chat')} /></>}
        {(['ready', 'loading', 'empty', 'failed', 'disabled'] as DataState[]).map(value =>
          <Button key={value} label={value[0]!.toUpperCase() + value.slice(1)} selected={state === value} onPress={() => setState(value)} />)}
      </ScrollView>
    </View>
    {state !== 'ready' ? <StateNotice state={state} retry={() => setState('ready')} /> :
      <View style={{ flex: 1, flexDirection: wide ? 'row' : 'column' }}>
        <View style={{ flex: 1, display: wide || screen === 'timeline' ? 'flex' : 'none', minHeight: 0 }}><Timeline /></View>
        <View style={{ flex: 1, display: wide || screen === 'chat' ? 'flex' : 'none', minHeight: 0, borderLeftWidth: wide ? 1 : 0, borderColor: colours.line }}><Chat /></View>
      </View>}
  </SafeAreaView></SafeAreaProvider>;
}
