import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useAccount } from '../../account/AccountProvider.tsx';
import type { ReadScope } from '../../account/contracts.ts';
import { isSignedIn, webCopy } from '../../account/copy.ts';
import { isCanonicalUuid } from '../../api/paths.ts';
import { Screen } from '../../components/Screen.tsx';
import { Button } from '../../components/AccountPage.tsx';
import type { ThreadCalls } from '../../threads/api.ts';
import type { Detail, Message } from '../../threads/contracts.ts';
import { createThreadControls } from '../../threads/thread-controls.ts';
import { createComposer } from '../../threads/composer.ts';
import { browserDrafts } from '../../threads/storage.ts';
import { hasGap, messagePowers, recordRoute, validBody } from '../../threads/derive.ts';
import { useDeadline, useThreadPoll } from '../../threads/use-poll.ts';
import { copy } from '../../threads/copy.ts';
import { colors, space } from '../../theme/tokens.ts';
import Welcome from '../welcome.tsx';
export default function ThreadScreen(){
 const account=useAccount(),view=account.snapshot.account,params=useLocalSearchParams<{id:string}>();const id=params.id;
 const back={label:'Threads',onPress:()=>router.dismissTo('/')};
 if(view.kind==='checking'||view.kind==='starting')return <Screen back={back}><Text>{webCopy.checking}</Text></Screen>;
 if(view.kind==='unverified')return <Welcome/>;
 if(!isSignedIn(view))return null;
 if(!isCanonicalUuid(id))return <Screen back={back}><Text>{copy.lost}</Text></Screen>;
 if(!account.web||!view.scope||view.org.kind!=='chosen')return <Screen back={back}><Text>{copy.unavailable}</Text></Screen>;
 return <Thread key={`${view.scope.epoch}:${id}:${view.org.membership.role}`} calls={account.web.threads} scope={view.scope} id={id} role={view.org.membership.role} now={account.now}/>;
}
function Thread({calls,scope,id,role,now}:{calls:ThreadCalls;scope:ReadScope;id:string;role:string;now:()=>number}){
 const [pair]=useState(()=>{
  const controls=createThreadControls(calls,scope,id,now,m=>composer.reconcile(m),()=>browserDrafts.clear(scope,id));
  const composer=createComposer(calls,scope,id,browserDrafts,now,()=>Crypto.randomUUID(),m=>controls.sent(m),()=>controls.lost());return {controls,composer};
 });
 const {controls,composer}=pair;
 const state=useSyncExternalStore(controls.subscribe,controls.snapshot,controls.snapshot),draft=useSyncExternalStore(composer.subscribe,composer.snapshot,composer.snapshot);
 const [fold,setFold]=useState(false),[menu,setMenu]=useState<string|null>(null),[editing,setEditing]=useState<string|null>(null),[editBody,setEditBody]=useState('');
 const scroll=useRef<ScrollView>(null),positions=useRef(new Map<number,{y:number;height:number}>()),offset=useRef(0),height=useRef(0),focused=useRef(false),positioned=useRef(false),jumped=useRef<number|null>(null);
 const current=useRef(state);current.current=state;
 useFocusEffect(useCallback(()=>{focused.current=true;return()=>{focused.current=false;};},[]));
 const visible=()=>focused.current&&typeof document!=='undefined'&&document.visibilityState==='visible'&&document.hasFocus();
 const readVisible=()=>{if(!positioned.current||!visible())return;const seq=current.current.messages.filter(m=>{const p=positions.current.get(m.seq);return p&&p.y<offset.current+height.current&&p.y+p.height>offset.current;}).at(-1)?.seq;if(seq)void controls.displayed(seq);};
 const jump=()=>{const seq=current.current.jumpSeq;if(seq===null)return;const p=positions.current.get(seq);if(p){scroll.current?.scrollTo({y:p.y,animated:false});offset.current=p.y;jumped.current=seq;positioned.current=true;readVisible();}};
 useEffect(()=>{void controls.load();return()=>{controls.dispose();composer.dispose();};},[controls,composer]);
 useEffect(()=>{if(state.jumpSeq!==jumped.current)jump();},[state.jumpSeq,state.messages]);
 useEffect(()=>{const timer=setInterval(readVisible,15000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{if(!state.busy)readVisible();},[state.busy,state.messages]);
 const paused=useThreadPoll(()=>controls.poll(),now),waiting=useDeadline(Math.max(state.waitUntil,draft.waitUntil),now),disabled=state.busy||draft.busy||waiting;
 const back={label:'Threads',onPress:()=>router.dismissTo('/')};
 return <Screen back={back} list={()=> <View style={styles.frame}>
  {state.detail?<View testID="thread-card" style={styles.card}>
   <Pressable testID="thread-card-fold" role="button" aria-expanded={fold} aria-label="Record details" onPress={()=>setFold(!fold)} style={styles.row}><Text role="heading" style={styles.title}>{state.detail.card.title}</Text>{state.detail.card.status?<Text style={styles.status}>{state.detail.card.status}</Text>:null}<Text>{fold?'⌃':'⌄'}</Text></Pressable>
   <View style={styles.row}>{state.detail.card.facts.map((fact,i)=><Text key={i} style={[styles.body,{flex:1}]}>{fact}</Text>)}</View>
   {fold?<ScrollView style={{maxHeight:180}} testID="thread-details"><Text style={styles.body}>{[state.detail.card.body,state.detail.card.notes].filter(Boolean).join('\n')||'No further details.'}</Text><Text style={styles.body}>{state.detail.tags.map(t=>t.name).join(' · ')||'No tags'}</Text>{recordRoute(state.detail)?<Button label="Open the record" onPress={()=>router.push(recordRoute(state.detail!)!)} />:null}{state.detail.thread.kind==='private'?<Text style={styles.body}>{copy.privacy}</Text>:null}</ScrollView>:null}
   <Button testID="thread-star" label={state.detail.thread.starred?'Unstar thread':'Star thread'} disabled={disabled||state.needsRefresh} onPress={()=>{void controls.mutate({kind:'star',value:!state.detail!.thread.starred});}}/>
  </View>:null}
  {state.detail?.pins&&!state.messages.some(m=>m.id===state.detail!.pins!.messageId&&m.deletedAt!==null)?<Pressable testID="thread-pin" role="button" onPress={()=>{void controls.jumpPin().then(jump);}} disabled={disabled} style={styles.pin}><Text numberOfLines={1} style={styles.body}>⌖ {state.messages.find(m=>m.id===state.detail!.pins!.messageId)?.body??'Pinned message — tap to find it'}</Text></Pressable>:null}
  {state.phase==='loading'?<Text testID="thread-loading" style={styles.body}>{copy.threadLoading}</Text>:null}
  {state.message?<Text testID="thread-status" role="status" style={styles.body}>{state.message}</Text>:null}
  {waiting?<Text style={styles.body}>{copy.wait}</Text>:null}{paused?<Text style={styles.body}>{copy.paused}</Text>:null}
  {state.phase!=='lost'?<Button testID="thread-refresh" label="Check current thread" disabled={disabled} onPress={()=>{void controls.load();}}/>:null}
  <ScrollView testID="thread-messages" ref={scroll} style={{flex:1}} onLayout={e=>{height.current=e.nativeEvent.layout.height;readVisible();}} onScroll={e=>{offset.current=e.nativeEvent.contentOffset.y;readVisible();}} scrollEventThrottle={100} onContentSizeChange={()=>{if(!positioned.current||current.current.jumpSeq!==jumped.current)jump();}}>
   {(state.messages[0]?.seq??0)>1?<Button testID="thread-earlier" label={`Show ${state.messages[0]!.seq-1} earlier messages`} disabled={disabled} onPress={()=>{jumped.current=null;void controls.page('earlier');}}/>:null}
   {state.phase==='ready'&&state.messages.length===0?<Text style={styles.body}>{copy.emptyMessages}</Text>:null}
   {state.messages.map(message=>{const powers=messagePowers(message,scope.userId,role);return <View key={message.id} testID={`message-${message.id}`} onLayout={e=>{positions.current.set(message.seq,e.nativeEvent.layout);if(!positioned.current)jump();}} style={styles.message}>
    {message.seq===state.firstUnreadSeq?<View testID="thread-unread-line" style={styles.unread}><Text style={styles.small}>Unread</Text></View>:null}
    <View style={styles.row}><Text style={styles.author}>{message.authorName??'Former member'}</Text><Text style={styles.small}>{new Date(message.createdAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}{message.editedAt?' · edited':''}</Text>{powers.edit||powers.delete||powers.pin?<Pressable testID={`message-menu-${message.id}`} role="button" aria-label={`Actions for message by ${message.authorName??'former member'}`} onPress={()=>setMenu(menu===message.id?null:message.id)} style={styles.menu}><Text>•••</Text></Pressable>:null}</View>
    <MessageBody body={message.body}/>
    {menu===message.id?<View style={styles.actions}>
     {powers.edit?<Button label="Edit message" disabled={disabled||state.needsRefresh} onPress={()=>{setEditing(message.id);setEditBody(message.body??'');}}/>:null}
     {powers.delete?<Button label="Delete message" disabled={disabled||state.needsRefresh} onPress={()=>{void controls.mutate({kind:'delete',message});setMenu(null);}}/>:null}
     {powers.pin?<Button label={state.detail?.pins?.messageId===message.id?'Unpin message':'Pin message'} disabled={disabled||state.needsRefresh||Boolean(state.detail?.pins&&state.detail.pins.messageId!==message.id)} onPress={()=>{void controls.mutate(state.detail?.pins?.messageId===message.id?{kind:'unpin'}:{kind:'pin',message});setMenu(null);}}/>:null}
    </View>:null}
    {editing===message.id?<View><TextInput testID="message-edit" accessibilityLabel="Edit message" multiline value={editBody} onChangeText={setEditBody} editable={!disabled} maxLength={8000} style={styles.input}/><Button label="Save edited message" disabled={disabled||state.needsRefresh||!validBody(editBody)} onPress={()=>{void controls.mutate({kind:'edit',message,body:editBody});}}/><Button label="Close editor" disabled={disabled} onPress={()=>setEditing(null)}/></View>:null}
   </View>;})}
   {state.detail&&((state.messages.at(-1)?.seq??0)<state.detail.thread.lastSeq||hasGap(state.messages))?<Button testID="thread-newer" label="Show newer messages" disabled={disabled} onPress={()=>{jumped.current=null;void controls.page('newer');}}/>:null}
  </ScrollView>
  {state.phase==='ready'&&state.detail?<View style={styles.composer}>
   {draft.message?<Text testID="composer-status" role="status" style={styles.small}>{draft.message}</Text>:null}
   <TextInput testID="thread-composer" accessibilityLabel="Message" multiline value={draft.body} onChangeText={composer.edit} editable={!state.busy&&!draft.busy&&!draft.pending?.locked} maxLength={8000} placeholder="Message" style={styles.input}/>
   <View style={styles.actions}><Button testID="thread-send" label={draft.pending?.locked?'Retry same message':'Send message'} primary disabled={disabled||draft.refused||!validBody(draft.body)} onPress={()=>{void composer.send();}}/>{draft.pending?<Button testID="draft-discard" label="Discard draft" disabled={disabled} onPress={composer.discard}/>:null}{draft.refused?<Button label="Use a new message ID" disabled={disabled} onPress={composer.newId}/>:null}</View>
  </View>:null}
 </View>}/>;
}
function MessageBody({body}:{body:string|null}){if(body===null)return <Text style={styles.deleted}>Message deleted</Text>;return <Text style={styles.body}>{body.split(/(https?:\/\/[^\s]+)/g).map((part,i)=>/^https?:\/\//.test(part)?<Text key={i} role="link" style={{textDecorationLine:'underline'}} onPress={()=>{try{const u=new URL(part);if(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password)void Linking.openURL(u.href).catch(()=>{});}catch{/* text stays visible */}}}>{part}</Text>:part)}</Text>;}
const styles=StyleSheet.create({frame:{flex:1,width:'100%',maxWidth:space.maxContentWidth,alignSelf:'center',paddingHorizontal:12,paddingBottom:12,gap:6},card:{padding:12,borderRadius:14,borderWidth:1,borderColor:colors.line,backgroundColor:colors.card,gap:8},row:{flexDirection:'row',alignItems:'center',gap:8},title:{flex:1,fontSize:17,fontWeight:'600',color:colors.heading},status:{fontSize:11,color:colors.sageText,backgroundColor:colors.sage,padding:4,borderRadius:6,maxWidth:110},body:{fontSize:15,lineHeight:21,color:colors.body},pin:{minHeight:44,justifyContent:'center',borderBottomWidth:1,borderColor:colors.line},message:{paddingVertical:10,borderBottomWidth:1,borderColor:colors.rowLine,gap:5},author:{fontSize:13,fontWeight:'600',color:colors.heading},small:{fontSize:12,color:colors.muted},menu:{marginLeft:'auto',minWidth:44,minHeight:44,alignItems:'center',justifyContent:'center'},unread:{borderTopWidth:1,borderColor:colors.sageText,paddingVertical:5},deleted:{fontSize:15,color:colors.muted,fontStyle:'italic'},actions:{flexDirection:'row',flexWrap:'wrap',gap:6},composer:{borderWidth:1,borderColor:colors.line,borderRadius:14,backgroundColor:colors.card,padding:10,gap:6},input:{color:colors.body,minHeight:44,maxHeight:120,fontSize:15,padding:8,borderWidth:1,borderColor:colors.line,borderRadius:8}});
