import { ComposerInput, ThreadAction } from '../../threads/Presentation.tsx';
import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useAccount } from '../../account/AccountProvider.tsx';
import type { ReadScope } from '../../account/contracts.ts';
import { isSignedIn, webCopy } from '../../account/copy.ts';
import type { ThreadCalls } from '../../threads/api.ts';
import { browserCreates, createNewThread, validCreate } from '../../threads/create.ts';
import { createOptions } from '../../threads/options.ts';
import { useDeadline } from '../../threads/use-poll.ts';
import { copy } from '../../threads/copy.ts';
import { Screen } from '../../components/Screen.tsx';
import { space } from '../../theme/tokens.ts';
import { themedStyles, useTheme } from '../../theme/theme.ts';
import Welcome from '../welcome.tsx';
const back={label:'Threads',onPress:()=>router.dismissTo('/')};
export default function NewThread(){
 const { colors } = useTheme();
 const account=useAccount(),view=account.snapshot.account;
 if(view.kind==='checking'||view.kind==='starting')return <Screen back={back}><Text style={{ color: colors.plain }}>{webCopy.checking}</Text></Screen>;
 if(view.kind==='unverified')return <Welcome/>;
 if(!isSignedIn(view))return null;
 if(!account.web||!view.scope||view.org.kind!=='chosen')return <Screen back={back}><Text style={{ color: colors.plain }}>{copy.unavailable}</Text></Screen>;
 return <Composer key={view.scope.epoch} calls={account.web.threads} scope={view.scope} now={account.now}/>;
}
function Composer({calls,scope,now}:{calls:ThreadCalls;scope:ReadScope;now:()=>number}){
 const styles = useStyles();
 const { colors } = useTheme();
 const [controls]=useState(()=>createNewThread(calls,scope,browserCreates,now,()=>Crypto.randomUUID(),id=>router.replace(`/threads/${id}`)));
 const [members]=useState(()=>createOptions(calls,scope,'members',now));
 const state=useSyncExternalStore(controls.subscribe,controls.snapshot,controls.snapshot),choices=useSyncExternalStore(members.subscribe,members.snapshot,members.snapshot),d=state.draft;
 useEffect(()=>()=>{controls.dispose();members.dispose();},[controls,members]);
 useEffect(()=>{if(d.private)void members.load();},[d.private,members]);
 const waiting=useDeadline(state.waitUntil,now),memberWaiting=useDeadline(choices.waitUntil,now),locked=state.busy||d.locked||state.lost;
 const toggle=(id:string)=>controls.edit({participantIds:d.participantIds.includes(id)?d.participantIds.filter(p=>p!==id):[...d.participantIds,id]});
 return <Screen title="New thread" back={back} list={({heading})=> <View style={styles.frame}>{heading}
  <ScrollView style={{flex:1}} contentContainerStyle={{flexGrow:1,gap:12,paddingBottom:12}} keyboardShouldPersistTaps="handled">

   <Pressable testID="new-thread-private" role="switch" aria-checked={d.private} disabled={locked} onPress={()=>controls.edit({private:!d.private})} style={styles.toggle}><Text style={styles.label}>Private</Text><Text style={styles.label}>{d.private?'On':'Off'}</Text></Pressable>
   {d.private?<View testID="new-thread-private-fields" style={{gap:10}}>
    <Text style={styles.hint}>{copy.privacy}</Text>
    <TextInput testID="new-thread-title" accessibilityLabel="Private thread title" placeholder="Private thread title" placeholderTextColor={colors.muted} value={d.title} onChangeText={title=>controls.edit({title})} editable={!locked} maxLength={80} style={styles.input}/>
    <Text style={styles.label}>People · {d.participantIds.length} selected</Text><Text style={styles.hint}>You are included. Choose up to 49 other members.</Text>
    {choices.busy?<Text testID="new-members-loading" style={styles.hint}>Loading members…</Text>:null}
    {choices.message?<Text testID="new-members-status" role="status" style={styles.hint}>{choices.message}</Text>:null}
    {choices.loaded&&choices.rows.length===0?<Text testID="new-members-empty" style={styles.hint}>No other members are available. Only you will see this thread.</Text>:null}
    {choices.rows.map(m=><Pressable key={m.userId} testID={`new-member-${m.userId}`} role="checkbox" aria-checked={d.participantIds.includes(m.userId)} disabled={locked||(!d.participantIds.includes(m.userId)&&d.participantIds.length>=49)} onPress={()=>toggle(m.userId)} style={styles.member}><Text style={styles.label}>{m.name||m.email}</Text><Text style={{ color: colors.plain }}>{d.participantIds.includes(m.userId)?'✓':'○'}</Text></Pressable>)}
    {d.participantIds.some(id=>!choices.rows.some(m=>m.userId===id))?<Text style={styles.hint}>Some saved selections are not in this member list. {d.locked?'Retry the exact saved request to confirm its outcome.':'Refresh members or clear these selections before sending.'}</Text>:null}
    {!d.locked&&d.participantIds.length?<ThreadAction label="Clear selected people" disabled={state.busy} onPress={()=>controls.edit({participantIds:[]})}/>:null}
    <ThreadAction testID="new-members-refresh" label="Refresh members" disabled={locked||choices.busy||memberWaiting} onPress={()=>{void members.load();}}/>
   </View>:null}
   <View style={styles.startHint}><Text testID="new-thread-hint" style={[styles.hint,{textAlign:'center'}]}>Just write. Your first message starts the thread.</Text></View>
  </ScrollView>
  {state.message?<Text testID="new-thread-status" role="status" style={styles.hint}>{state.message}</Text>:null}
  {waiting?<Text style={styles.hint}>{copy.wait}</Text>:null}
   <View style={styles.composerRow}><ComposerInput testID="new-thread-body" accessibilityLabel="First message" autoFocus multiline placeholder="What's the work?" value={d.body} onChangeText={body=>controls.edit({body})} editable={!locked} maxLength={8000}/><ThreadAction testID="new-thread-send" label={d.locked?'Retry same thread':'Send'} display={d.locked?'Retry':'Send'} primary disabled={state.busy||state.lost||waiting||d.refused||!validCreate(d)||(!d.locked&&d.private&&(!choices.loaded||choices.busy||d.participantIds.some(id=>!choices.rows.some(m=>m.userId===id))))} onPress={()=>{void controls.send();}}/></View>
  {state.pending||d.refused?<View style={styles.actions}>
   {state.pending?<ThreadAction testID="new-thread-discard" label="Discard draft" disabled={state.busy} onPress={controls.discard}/>:null}
   {d.refused?<ThreadAction testID="new-thread-new-ids" label="Start again with new IDs" disabled={state.busy||waiting} onPress={controls.newIds}/>:null}
  </View>:null}
 </View>}/>;
}
const useStyles = themedStyles((colors) => ({frame:{flex:1,maxWidth:space.maxContentWidth,width:'100%',alignSelf:'center',paddingHorizontal:16,paddingBottom:12,gap:12},startHint:{flex:1,minHeight:100,justifyContent:'center',paddingHorizontal:20},composerRow:{flexDirection:'row',alignItems:'flex-end',gap:4,padding:6,backgroundColor:colors.card,borderWidth:1,borderColor:colors.line,borderRadius:14},input:{fontSize:16,minHeight:48,color:colors.body,padding:12,borderWidth:1,borderColor:colors.line,borderRadius:10,backgroundColor:colors.card},toggle:{minHeight:48,flexDirection:'row',justifyContent:'space-between',alignItems:'center',borderBottomWidth:1,borderColor:colors.line},label:{fontSize:15,color:colors.heading},hint:{fontSize:13,lineHeight:19,color:colors.muted},member:{minHeight:48,flexDirection:'row',justifyContent:'space-between',alignItems:'center',padding:10,borderWidth:1,borderColor:colors.line,borderRadius:10},actions:{flexDirection:'row',flexWrap:'wrap',gap:8}}));
