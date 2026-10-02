import { groupDates, ThreadAction } from '../threads/Presentation.tsx';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createListControls } from '../threads/list-controls.ts';
import { filters, type Row } from '../threads/contracts.ts';
import { groupedRows, firstName, unreadLabel } from '../threads/derive.ts';
import { foldedGroups, saveFolds } from '../threads/storage.ts';
import { useThreadPoll, useDeadline } from '../threads/use-poll.ts';
import { copy } from '../threads/copy.ts';
import type { ThreadCalls } from '../threads/api.ts';
import type { ReadScope } from '../account/contracts.ts';
import { Button } from '../components/AccountPage.tsx';
import { Redirect, router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAccount } from '../account/AccountProvider.tsx';
import { isSignedIn, threadsCopy, webCopy } from '../account/copy.ts';
import { Calendar, People, ThreadKindIcon } from '../components/Icons.tsx';
import { PlainScreen, Screen } from '../components/Screen.tsx';
import Welcome from './welcome.tsx';
import { colors, space, type } from '../theme/tokens.ts';

/** The one scoped list of threads; account guards resolve before any thread read. */
export default function Home() {
	const { snapshot, web, now } = useAccount();
	const account = snapshot.account;
	if (account.kind === 'checking' || account.kind === 'starting') {
		return <PlainScreen title="Captain" back={null}><Text testID="shell-checking" style={styles.body}>{webCopy.checking}</Text></PlainScreen>;
	}
	if (account.kind === 'unverified') return <Welcome />;
	if (!isSignedIn(account)) return <Redirect href="/welcome" />;
	if (account.org.kind !== 'chosen') return <Redirect href="/organisation" />;
	if(!web||!account.scope)return <Screen title={threadsCopy.heading}><View style={styles.pinned}><PinnedRow testID="threads-pinned-equipment" label={threadsCopy.pinnedEquipment} detail={threadsCopy.pinnedEquipmentDetail} icon={<Calendar color={colors.sageText}/>} onPress={()=>router.push('/equipment')}/><PinnedRow testID="threads-pinned-team" label={threadsCopy.pinnedTeam} detail={threadsCopy.pinnedTeamDetail} icon={<People color={colors.muted}/>}/></View><Text testID="threads-empty">{copy.unavailable}</Text></Screen>;
 return <ThreadList key={account.scope.epoch} calls={web.threads} scope={account.scope} now={now} />;
}
function ThreadList({calls,scope,now}:{calls:ThreadCalls;scope:ReadScope;now:()=>number}){
 const [controls]=useState(()=>createListControls(calls,scope,now));
 const state=useSyncExternalStore(controls.subscribe,controls.snapshot,controls.snapshot);
 const [folds,setFolds]=useState(foldedGroups);
 useEffect(()=>{void controls.load();return()=>controls.dispose();},[controls]);
 const paused=useThreadPoll(()=>controls.load(),now),waiting=useDeadline(state.waitUntil,now);
 const busy=state.phase==='loading';
 const toggle=(key:string)=>{const next=new Set(folds);if(next.has(key))next.delete(key);else next.add(key);setFolds(next);saveFolds(next);};
 return <Screen title={threadsCopy.heading} list={({heading,contentContainerStyle})=><View style={{flex:1}}><ScrollView testID="threads-list" contentContainerStyle={[contentContainerStyle,{paddingBottom:80}]}>
  {heading}
  <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="threads-filters" style={{flexGrow:0,marginBottom:10}} contentContainerStyle={styles.filters}><View role="radiogroup" aria-label={threadsCopy.filterGroup} style={styles.filters}>
   {threadsCopy.filters.map((filter,index)=><Pressable key={filter} testID={`threads-filter-${index}`} disabled={index>5||busy||waiting} aria-disabled={index>5||busy||waiting} role="radio" aria-checked={state.filter===filters[index]} aria-label={filter} accessibilityHint={index>5?copy.files:undefined} onPress={()=>{void controls.filter(filters[index]!);}} style={[styles.filter,state.filter===filters[index]&&styles.filterOn]}><Text style={[styles.filterText,state.filter===filters[index]&&styles.filterTextOn]}>{filter}</Text></Pressable>)}
  </View></ScrollView>{state.filter==='files'||state.filter==='people'?<Text style={styles.detail}>{copy.files}</Text>:null}
  <View style={styles.pinned}>
   <PinnedRow testID="threads-pinned-equipment" label={threadsCopy.pinnedEquipment} detail={threadsCopy.pinnedEquipmentDetail} icon={<Calendar color={colors.sageText}/>} onPress={()=>router.push('/equipment')}/>
   <PinnedRow testID="threads-pinned-team" label={threadsCopy.pinnedTeam} detail={threadsCopy.pinnedTeamDetail} icon={<People color={colors.muted}/>}/>
  </View>
  {busy?<Text testID="threads-loading" style={styles.body}>{copy.loading}</Text>:null}
  {state.message?<View style={styles.statusRow}><Text testID="threads-status" role="status" style={[styles.body,{flex:1}]}>{state.message}</Text>{state.phase==='failed'?<ThreadAction testID="threads-refresh" label="Try again" disabled={busy||waiting} onPress={()=>{void controls.load();}}/>:null}</View>:null}
  {paused?<Text style={styles.body}>{copy.paused}</Text>:null}
  {state.data?.available&&state.data.threads.length===0?<Text testID="threads-empty" style={styles.body}>{copy.empty}</Text>:null}
  {state.data?groupedRows(state.data).map(({group,rows})=><View key={group.key} style={{marginTop:16}}>
   <Pressable testID={`thread-group-${group.key}`} role="button" aria-expanded={!folds.has(group.key)} onPress={()=>toggle(group.key)} style={styles.group}>
    <Text style={styles.detail}>{folds.has(group.key)?'›':'⌄'}</Text><Text style={styles.groupLabel} numberOfLines={1}>{group.label}</Text><Text style={styles.groupMeta} numberOfLines={1}>{[group.owner?.name,groupDates(group.startsOn,group.endsOn),`${group.threads} threads`].filter(Boolean).join(' · ')}</Text>{group.needsYou>0?<Text style={styles.pip} accessibilityLabel={`${group.needsYou} need you`}>{group.needsYou}</Text>:null}
   </Pressable>
   {!folds.has(group.key)&&rows.length?<View style={{gap:4}}>{rows.map(row=><ThreadRow key={row.id} row={row}/>)}</View>:null}
   {!folds.has(group.key)&&rows.length===0?<Text style={styles.detail}>Load more threads to see this group.</Text>:null}
  </View>):null}
  {state.data?.nextCursor?<ThreadAction testID="threads-more" label="Show more" disabled={busy||waiting} onPress={()=>{void controls.load(true);}}/>:null}
 </ScrollView><View style={{position:'absolute',right:16,bottom:16}}><Button testID="threads-new" label="New thread" primary disabled={state.phase==='lost'} onPress={()=>router.push('/threads/new')}/></View></View>}/>;
}
function ThreadRow({row}:{row:Row}){
 return <Pressable testID={`thread-row-${row.id}`} onPress={()=>router.push(`/threads/${row.id}`)} role="link" style={[styles.threadRow,row.needsYou&&{backgroundColor:colors.needsYou,borderColor:colors.needsYouLine}]}>
  <View style={styles.icon}><ThreadKindIcon kind={row.record?.kind??row.kind} color={colors.sageText}/></View><View style={styles.text}>
  <View style={styles.line}><Text style={[styles.threadTitle,row.needsYou&&{fontWeight:'700'}]} numberOfLines={1}>{row.title}</Text><Text style={styles.time}>{row.lastMessageAt?new Date(row.lastMessageAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'No messages'}</Text></View>
  <Text style={styles.facts} numberOfLines={1}>{[row.status,...row.facts].filter(Boolean).join(' · ')}</Text>
  <View style={styles.line}><Text style={styles.preview} numberOfLines={1}>{row.lastMessage?`${firstName(row.lastMessage.authorName)}: ${row.lastMessage.excerpt}`:'No messages yet'}</Text>{row.needsYou?<Text testID={`thread-unread-${row.id}`} accessibilityLabel={row.unread?`${unreadLabel(row.unread)} unread`:'Needs you'} style={styles.pip}>{row.unread?unreadLabel(row.unread):'•'}</Text>:null}</View></View>
 </Pressable>;
}

/** A pinned row opens a view that is not a list of threads. One without `onPress` is listed but not available. */
function PinnedRow({ testID, label, detail, icon, onPress }: { testID: string; label: string; detail: string; icon: React.ReactNode; onPress?: () => void }) {
 const content = <><View aria-hidden>{icon}</View><Text numberOfLines={1} style={[styles.label,!onPress&&styles.unavailable]}>{label}</Text></>;
 const style = [styles.row,onPress?{flex:1.25}:{backgroundColor:colors.page}];
	if (!onPress) return <View testID={testID} style={style} accessible aria-label={`${label}. ${detail}`} aria-disabled>{content}</View>;
	return <Pressable testID={testID} style={style} onPress={onPress} role="link" aria-label={`${label}. ${detail}`}>{content}</Pressable>;
}

const styles = StyleSheet.create({
 statusRow:{flexDirection:'row',alignItems:'center',gap:8},group:{minHeight:44,flexDirection:'row',alignItems:'center',gap:8},groupLabel:{maxWidth:'36%',flexShrink:1,fontSize:15,fontWeight:'600',color:colors.heading},groupMeta:{flex:1,minWidth:0,fontSize:11,color:colors.muted},threadRow:{flexDirection:'row',alignItems:'flex-start',gap:8,borderWidth:1,borderRadius:12,borderColor:colors.rowLine,paddingHorizontal:10,paddingVertical:8,backgroundColor:colors.card},line:{flexDirection:'row',alignItems:'center',gap:8},threadTitle:{flex:1,minWidth:0,fontSize:14,fontWeight:'500',color:colors.heading},time:{fontSize:11,color:colors.muted},facts:{fontSize:12,color:colors.sageText,marginTop:3},preview:{flex:1,minWidth:0,fontSize:13,color:colors.muted,marginTop:3},pip:{fontSize:11,fontWeight:'600',minWidth:17,textAlign:'center',borderRadius:9,paddingHorizontal:4,backgroundColor:colors.sageText,color:colors.card},
	body: { fontSize: type.body, lineHeight: 21, color: colors.body },
	filters: { flexDirection: 'row', gap: 6 },
	filter: { minHeight: space.minTarget, paddingHorizontal: 12, borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
	filterOn: { backgroundColor: colors.action, borderColor: colors.action },
	filterText: { fontSize: 14, color: colors.body },
	filterTextOn: { fontWeight: '600', color: colors.actionText },
 pinned: { flexDirection:'row',gap:6,marginBottom:8 },
 row: { flex:1,minWidth:0,minHeight:44,paddingHorizontal:10,flexDirection:'row',gap:6,alignItems:'center',borderWidth:1,borderColor:colors.line,borderRadius:12,backgroundColor:colors.pinned },
 icon: { width:26,height:26,borderRadius:7,backgroundColor:colors.sage,alignItems:'center',justifyContent:'center' },
	text: { flex: 1, minWidth: 0 },
	label: { flexShrink:1,fontSize:12, fontWeight: '600', color: colors.heading },
	unavailable: { color: colors.muted },
	detail: { marginTop: 2, fontSize: type.rowDetail, lineHeight: type.rowDetailLine, color: colors.muted }
});
