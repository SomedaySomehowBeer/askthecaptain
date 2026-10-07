import { ComposerInput, ThreadAction, clockTime, initials, messageDay, dayLabel } from '../../threads/Presentation.tsx';
import { RecordCard } from '../../threads/RecordCard.tsx';
import { ChangeLine, FoldedRun } from '../../threads/ChangeLine.tsx';
import { displayItems, itemMessages } from '../../threads/runs.ts';
import { createRecordStore, namesFor } from '../../threads/cards/store.ts';
import type { CardHooks } from '../../threads/cards/useSaver.ts';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useAccount } from '../../account/AccountProvider.tsx';
import type { ReadScope } from '../../account/contracts.ts';
import { isSignedIn, webCopy } from '../../account/copy.ts';
import { isCanonicalUuid } from '../../api/paths.ts';
import { PlainText, Screen } from '../../components/Screen.tsx';
import { Button } from '../../components/AccountPage.tsx';
import type { ThreadCalls } from '../../threads/api.ts';
import type { Detail, Message } from '../../threads/contracts.ts';
import { createThreadControls } from '../../threads/thread-controls.ts';
import { createComposer } from '../../threads/composer.ts';
import { browserDrafts } from '../../threads/storage.ts';
import { hasGap, messagePowers, validBody } from '../../threads/derive.ts';
import { useDeadline, useThreadPoll } from '../../threads/use-poll.ts';
import { copy } from '../../threads/copy.ts';
import { space, type } from '../../theme/tokens.ts';
import { Clock } from '../../components/Icons.tsx';
import { themedStyles, useTheme } from '../../theme/theme.ts';
import Welcome from '../welcome.tsx';
export default function ThreadScreen(){
 const account=useAccount(),view=account.snapshot.account,params=useLocalSearchParams<{id:string;edit?:string}>();const id=params.id;
 const back={label:'Threads',onPress:()=>router.dismissTo('/')};
 if(view.kind==='checking'||view.kind==='starting')return <Screen record back={back}><PlainText>{webCopy.checking}</PlainText></Screen>;
 if(view.kind==='unverified')return <Welcome/>;
 if(!isSignedIn(view))return null;
 if(!isCanonicalUuid(id))return <Screen record back={back}><PlainText>{copy.lost}</PlainText></Screen>;
 if(!account.web||!view.scope||view.org.kind!=='chosen')return <Screen record back={back}><PlainText>{copy.unavailable}</PlainText></Screen>;
 return <Thread key={`${view.scope.epoch}:${id}:${view.org.membership.role}`} calls={account.web.threads} scope={view.scope} id={id} role={view.org.membership.role} now={account.now} edit={typeof params.edit==='string'?params.edit:null}/>;
}
function Thread({calls,scope,id,role,now,edit}:{calls:ThreadCalls;scope:ReadScope;id:string;role:string;now:()=>number;edit:string|null}){
 const styles = useStyles();
 const { colors } = useTheme();
 const [pair]=useState(()=>{
  const controls=createThreadControls(calls,scope,id,now,m=>composer.reconcile(m),()=>browserDrafts.clear(scope,id));
  const composer=createComposer(calls,scope,id,browserDrafts,now,()=>Crypto.randomUUID(),m=>controls.sent(m),()=>controls.lost());
  const record=createRecordStore(calls,scope,now,()=>controls.lost());
  // Stable for the screen: a card write reloads the record and reconciles the thread (the change line comes by the feed).
  const hooks:CardHooks={now,saved:()=>{void record.load();void controls.refresh();},reload:()=>{void record.load();void controls.refresh();},lost:()=>controls.lost()};
  return {controls,composer,record,hooks};
 });
 const {controls,composer,record,hooks}=pair;
 const state=useSyncExternalStore(controls.subscribe,controls.snapshot,controls.snapshot),draft=useSyncExternalStore(composer.subscribe,composer.snapshot,composer.snapshot);
 const recordState=useSyncExternalStore(record.subscribe,record.snapshot,record.snapshot);
 const cardKey=state.detail?JSON.stringify(state.detail.card):'';
 useEffect(()=>{record.detail(state.detail,true);},[cardKey]);
 useEffect(()=>{record.lines(state.messages);},[state.messages]);
 useEffect(()=>()=>record.dispose(),[record]);
 const confirmed=useMemo(()=>state.messages.flatMap(m=>m.kind==='change'&&m.changeSetId?[m.changeSetId]:[]),[state.messages]);
 const wording=useMemo(()=>({names:namesFor(state.detail,recordState,state.messages),zone:recordState.zone??undefined,year:new Date().getFullYear(),unit:typeof state.detail?.card.fold.unitLabel==='string'?state.detail.card.fold.unitLabel:null}),[state.detail,recordState,state.messages]);
 const [unfolded,setUnfolded]=useState<ReadonlySet<string>>(()=>new Set());
 const items=useMemo(()=>displayItems(state.messages,{unfolded,firstUnreadSeq:state.firstUnreadSeq}),[state.messages,unfolded,state.firstUnreadSeq]);
 const [fold,setFold]=useState(false),[menu,setMenu]=useState<string|null>(null),[editing,setEditing]=useState<string|null>(null),[editBody,setEditBody]=useState('');
 useEffect(()=>{if(edit)setFold(true);},[edit]);
 // The unfolded card is the first thing in the thread's scroll (it grows to its content, R3 boards 1 to 3), so opening it
 // shows it from the top, and a jump while it is open keeps it in view.
 const foldOpen=useRef(fold);foldOpen.current=fold;
 useEffect(()=>{if(fold){scroll.current?.scrollTo({y:0,animated:false});offset.current=0;}},[fold]);
 const scroll=useRef<ScrollView>(null),positions=useRef(new Map<number,{y:number;height:number}>()),offset=useRef(0),height=useRef(0),focused=useRef(false),positioned=useRef(false),jumped=useRef<number|null>(null);
 const current=useRef(state);current.current=state;
 useFocusEffect(useCallback(()=>{focused.current=true;return()=>{focused.current=false;};},[]));
 const visible=()=>focused.current&&typeof document!=='undefined'&&document.visibilityState==='visible'&&document.hasFocus();
 const readVisible=()=>{if(!positioned.current||!visible())return;const seq=current.current.messages.filter(m=>{const p=positions.current.get(m.seq);return p&&p.y<offset.current+height.current&&p.y+p.height>offset.current;}).at(-1)?.seq;if(seq)void controls.displayed(seq);};
 const jump=()=>{const seq=current.current.jumpSeq;if(seq===null)return;const p=positions.current.get(seq);if(p){const y=foldOpen.current?0:p.y;scroll.current?.scrollTo({y,animated:false});offset.current=y;jumped.current=seq;positioned.current=true;readVisible();}};
 useEffect(()=>{void controls.load();return()=>{controls.dispose();composer.dispose();};},[controls,composer]);
 useEffect(()=>{if(state.jumpSeq!==jumped.current)jump();},[state.jumpSeq,state.messages]);
 useEffect(()=>{const timer=setInterval(readVisible,15000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{if(!state.busy)readVisible();},[state.busy,state.messages]);
 const paused=useThreadPoll(()=>controls.poll(),now),waiting=useDeadline(Math.max(state.waitUntil,draft.waitUntil),now),disabled=state.busy||draft.busy||waiting;
 const back={label:'Threads',onPress:()=>router.dismissTo('/')};
 const history=`/threads/${id}/history`;
 const card=state.detail?<RecordCard detail={state.detail} calls={calls} scope={scope} now={now} fold={fold} setFold={setFold} disabled={disabled||state.needsRefresh} locked={state.phase!=='ready'} record={recordState} hooks={hooks} confirmed={confirmed} onTag={(tagId,attached)=>{void controls.mutate({kind:'tag',tagId,attached,expectedRevision:state.detail!.thread.revision});}} onMembers={()=>record.askMembers()}/>:null;
 return <Screen record back={back} headerAction={state.detail?<><Pressable testID="thread-history" role="button" aria-label="History" onPress={()=>router.push(history as never)} style={styles.star}><Clock color={colors.action}/></Pressable><Pressable testID="thread-star" role="button" aria-label={state.detail.thread.starred?'Unstar thread':'Star thread'} aria-disabled={disabled||state.needsRefresh} disabled={disabled||state.needsRefresh} onPress={()=>{void controls.mutate({kind:'star',value:!state.detail!.thread.starred});}} style={styles.star}><Text aria-hidden style={[styles.starIcon,(disabled||state.needsRefresh)&&{color:colors.muted}]}>{state.detail.thread.starred?'★':'☆'}</Text></Pressable></>:null} list={()=> <View style={styles.frame}>
  {fold?null:card?<View style={styles.cardBox}>{card}</View>:null}
  {state.detail?.pin&&!state.messages.some(m=>m.id===state.detail!.pin!.messageId&&m.deletedAt!==null)?<Pressable testID="thread-pin" role="button" onPress={()=>{void controls.jumpPin().then(jump);}} disabled={disabled} style={styles.pin}><Text numberOfLines={1} style={styles.body}>⌖ {state.messages.find(m=>m.id===state.detail!.pin!.messageId)?.body??'Pinned message — tap to find it'}</Text></Pressable>:null}
  {state.phase==='loading'?<Text testID="thread-loading" style={styles.body}>{copy.threadLoading}</Text>:null}
  {state.message?<View style={styles.statusRow}><Text testID="thread-status" role="status" style={[styles.body,{flex:1}]}>{state.message}</Text>{(state.phase==='failed'||state.needsRefresh||([copy.threadFailed,copy.wait,copy.gap,copy.mutationUnknown] as readonly string[]).includes(state.message))?<ThreadAction testID="thread-refresh" label="Try again" disabled={disabled} onPress={()=>{void controls.load();}}/>:null}</View>:null}
  {waiting?<Text style={styles.body}>{copy.wait}</Text>:null}{paused?<Text style={styles.body}>{copy.paused}</Text>:null}
  <ScrollView showsVerticalScrollIndicator={false} testID="thread-messages" ref={scroll} style={[styles.messages,fold&&styles.messagesOpen]} contentContainerStyle={styles.messagesContent} onLayout={e=>{height.current=e.nativeEvent.layout.height;readVisible();}} onScroll={e=>{offset.current=e.nativeEvent.contentOffset.y;readVisible();}} scrollEventThrottle={100} onContentSizeChange={()=>{if(!positioned.current||current.current.jumpSeq!==jumped.current)jump();}}>
   {fold&&card?<View style={styles.openCard}>{card}</View>:null}
   {(state.messages[0]?.seq??0)>1?<View style={styles.earlier}><ThreadAction dashed testID="thread-earlier" label={`Show ${state.messages[0]!.seq-1} earlier messages`} disabled={disabled} onPress={()=>{jumped.current=null;void controls.page('earlier');}}/></View>:null}
   {state.phase==='ready'&&state.messages.length===0?<Text style={[styles.body,styles.inset]}>{copy.emptyMessages}</Text>:null}
   {items.map((item,index)=>{const lines=itemMessages(item),message=lines[0]!,before=index>0?itemMessages(items[index-1]!).at(-1)!:null,powers=messagePowers(message,scope.userId,role);return <Fragment key={message.id}>
    {before===null||messageDay(message.createdAt)!==messageDay(before.createdAt)?<View testID={`message-day-${message.id}`} style={styles.day}><Text style={styles.dayText}>{dayLabel(message.createdAt)}</Text></View>:null}
    <View testID={item.kind==='foldedRun'?`run-${item.key}`:`message-${message.id}`} onLayout={e=>{for(const line of lines)positions.current.set(line.seq,e.nativeEvent.layout);if(!positioned.current)jump();}} style={[styles.message,message.kind==='change'&&styles.changeWrap]}>{lines.some(line=>line.seq===state.firstUnreadSeq)?<View testID="thread-unread-line" style={styles.unread}><Text style={styles.unreadText}>Unread</Text><View style={styles.unreadRule}/></View>:null}
    {item.kind==='foldedRun'?<FoldedRun lines={item.lines} options={wording} onUnfold={()=>setUnfolded(open=>new Set([...open,item.key]))}/>:message.kind==='change'?<ChangeLine message={message} options={wording} onOpen={route=>router.push(route as never)}/>:<><View style={styles.messageRow}><View aria-hidden style={styles.avatar}><Text style={styles.initials}>{initials(message.authorName)}</Text></View><View style={styles.messageMain}>
    <View style={[styles.messageHead,{paddingRight:32}]}><Text numberOfLines={1} style={styles.author}>{message.authorName??'Former member'}</Text><Text style={styles.time}>{clockTime(message.createdAt)}{message.editedAt?' · edited':''}</Text>{powers.edit||powers.delete||powers.pin?<Pressable testID={`message-menu-${message.id}`} role="button" aria-label={`Actions for message by ${message.authorName??'former member'}`} onPress={()=>setMenu(menu===message.id?null:message.id)} style={styles.menu}><Text style={styles.menuText}>•••</Text></Pressable>:null}</View>
    <MessageBody body={message.body}/>
    {menu===message.id?<View style={styles.actions}>
     {powers.edit?<Button label="Edit message" disabled={disabled||state.needsRefresh} onPress={()=>{setEditing(message.id);setEditBody(message.body??'');}}/>:null}
     {powers.delete?<Button label="Delete message" disabled={disabled||state.needsRefresh} onPress={()=>{void controls.mutate({kind:'delete',message});setMenu(null);}}/>:null}
     {powers.pin?<Button label={state.detail?.pin?.messageId===message.id?'Unpin message':'Pin message'} disabled={disabled||state.needsRefresh||Boolean(state.detail?.pin&&state.detail.pin.messageId!==message.id)} onPress={()=>{void controls.mutate(state.detail?.pin?.messageId===message.id?{kind:'unpin'}:{kind:'pin',message});setMenu(null);}}/>:null}
    </View>:null}
    {editing===message.id?<View><TextInput testID="message-edit" accessibilityLabel="Edit message" multiline value={editBody} onChangeText={setEditBody} editable={!disabled} maxLength={8000} style={styles.input}/><Button label="Save edited message" disabled={disabled||state.needsRefresh||!validBody(editBody)} onPress={()=>{void controls.mutate({kind:'edit',message,body:editBody});}}/><Button label="Close editor" disabled={disabled} onPress={()=>setEditing(null)}/></View>:null}
   </View></View></>}<View testID={`message-divider-${message.id}`} aria-hidden style={styles.messageLine}/></View></Fragment>;})}
   {state.detail&&((state.messages.at(-1)?.seq??0)<state.detail.thread.lastSeq||hasGap(state.messages))?<View style={styles.inset}><ThreadAction testID="thread-newer" label="Show newer messages" disabled={disabled} onPress={()=>{jumped.current=null;void controls.page('newer');}}/></View>:null}
  </ScrollView>
  {state.phase==='ready'&&state.detail?<View style={styles.composer}>
   {draft.message?<Text testID="composer-status" role="status" style={styles.composerStatus}>{draft.message}</Text>:null}
   <View style={styles.composerRow}><ComposerInput testID="thread-composer" accessibilityLabel="Message" multiline value={draft.body} onChangeText={composer.edit} editable={!state.busy&&!draft.busy&&!draft.pending?.locked} maxLength={8000} placeholder="Message"/>
   <ThreadAction testID="thread-send" label={draft.pending?.locked?'Retry same message':'Send message'} display={draft.pending?.locked?'Retry':'Send'} primary disabled={disabled||draft.refused||!validBody(draft.body)} onPress={()=>{void composer.send();}}/></View><View style={styles.actions}>{draft.pending?<ThreadAction testID="draft-discard" label="Discard draft" disabled={disabled} onPress={composer.discard}/>:null}{draft.refused?<ThreadAction label="Use a new message ID" disabled={disabled} onPress={composer.newId}/>:null}</View>
  </View>:null}
 </View>}/>;
}
function MessageBody({body}:{body:string|null}){
const styles = useStyles();if(body===null)return <Text style={styles.deleted}>Message deleted</Text>;return <Text style={styles.body}>{body.split(/(https?:\/\/[^\s]+)/g).map((part,i)=>/^https?:\/\//.test(part)?<Text key={i} role="link" style={{textDecorationLine:'underline'}} onPress={()=>{try{const u=new URL(part);if(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password)void Linking.openURL(u.href).catch(()=>{});}catch{/* text stays visible */}}}>{part}</Text>:part)}</Text>;}
/** R3 captain.css (Lines.dc.html): the card on the page with a 12 pt margin, then the messages edge to edge on white
 *  (`.msgs`, `.msg`, `.msg-main`, `.name`, `.time`, `.day`, `.unread`), and the composer card (`.composer`). */
const useStyles = themedStyles((colors) => ({
 frame:{flex:1,width:'100%',maxWidth:space.maxContentWidth,alignSelf:'center',paddingBottom:14,gap:8},
 cardBox:{marginHorizontal:12,marginBottom:2},
 openCard:{backgroundColor:colors.page,paddingHorizontal:12,paddingBottom:10,borderBottomWidth:1,borderColor:colors.rowLine},
 messages:{flex:1,backgroundColor:colors.card,borderTopWidth:1,borderColor:colors.rowLine},
 messagesOpen:{borderTopWidth:0},
 messagesContent:{paddingBottom:6},
 earlier:{paddingHorizontal:12,paddingTop:8},
 inset:{paddingHorizontal:16},
 star:{width:44,height:44,alignItems:'center',justifyContent:'center'},
 starIcon:{fontSize:24,lineHeight:28,color:colors.action},
 body:{fontSize:type.body,lineHeight:type.bodyLine,color:colors.body},
 statusRow:{flexDirection:'row',alignItems:'center',gap:6,paddingHorizontal:12},
 pin:{minHeight:36,justifyContent:'center',borderBottomWidth:1,borderColor:colors.line,marginHorizontal:12},
 message:{paddingTop:10,paddingHorizontal:16,backgroundColor:colors.card},
 changeWrap:{paddingTop:0,paddingBottom:0},
 day:{alignItems:'center',paddingTop:8,paddingBottom:2,backgroundColor:colors.card},
 dayText:{fontSize:type.meta,color:colors.muted},
 messageRow:{flexDirection:'row',gap:10},
 messageMain:{flex:1,minWidth:0,paddingBottom:10},
 messageHead:{flexDirection:'row',alignItems:'baseline',gap:8,minHeight:20},
 avatar:{width:28,height:28,borderRadius:14,alignItems:'center',justifyContent:'center',backgroundColor:colors.sage},
 initials:{fontSize:10,fontWeight:'700',color:colors.sageText},
 messageLine:{position:'absolute',bottom:0,left:54,right:16,height:1,backgroundColor:colors.rowLine},
 author:{flexShrink:1,minWidth:0,fontSize:type.body,lineHeight:type.bodyLine,fontWeight:'700',color:colors.heading},
 time:{fontSize:type.meta,color:colors.muted},
 small:{fontSize:11,color:colors.muted},
 menu:{position:'absolute',right:-12,top:-12,width:44,height:44,alignItems:'center',justifyContent:'center'},
 menuText:{fontSize:13,fontWeight:'700',color:colors.muted},
 unread:{flexDirection:'row',alignItems:'center',gap:8,marginHorizontal:-16,paddingHorizontal:16,paddingTop:6,paddingBottom:4},
 unreadText:{fontSize:11,fontWeight:'700',color:colors.action},
 unreadRule:{flex:1,height:1,backgroundColor:colors.action},
 deleted:{fontSize:type.body,color:colors.muted,fontStyle:'italic'},
 actions:{flexDirection:'row',flexWrap:'wrap',gap:6},
 composer:{marginHorizontal:12,marginTop:2,borderWidth:1,borderColor:colors.line,borderRadius:16,backgroundColor:colors.card,paddingVertical:6,paddingRight:6,paddingLeft:4},
 composerStatus:{fontSize:12,color:colors.muted,paddingHorizontal:10,paddingTop:2},
 composerRow:{flexDirection:'row',alignItems:'flex-end',gap:8},
 input:{color:colors.body,minHeight:44,maxHeight:120,fontSize:type.body,padding:8,borderWidth:1,borderColor:colors.fieldLine,borderRadius:10}
}));
