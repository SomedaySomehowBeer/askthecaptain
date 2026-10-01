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
import { Calendar, ChevronRight, People } from '../components/Icons.tsx';
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
	if(!web||!account.scope)return <Screen title={threadsCopy.heading}><PinnedRow testID="threads-pinned-equipment" label={threadsCopy.pinnedEquipment} detail={threadsCopy.pinnedEquipmentDetail} icon={<Calendar color={colors.sageText}/>} onPress={()=>router.push('/equipment')}/><PinnedRow testID="threads-pinned-team" label={threadsCopy.pinnedTeam} detail={threadsCopy.pinnedTeamDetail} icon={<People color={colors.muted}/>} last/><Text testID="threads-empty">{copy.unavailable}</Text></Screen>;
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
  <View role="radiogroup" aria-label={threadsCopy.filterGroup} style={styles.filters}>
   {threadsCopy.filters.map((filter,index)=><Pressable key={filter} testID={`threads-filter-${index}`} disabled={index>5||busy||waiting} aria-disabled={index>5||busy||waiting} role="radio" aria-checked={state.filter===filters[index]} aria-label={filter} onPress={()=>{void controls.filter(filters[index]!);}} style={[styles.filter,state.filter===filters[index]&&styles.filterOn]}><Text style={[styles.filterText,state.filter===filters[index]&&styles.filterTextOn]}>{filter}</Text></Pressable>)}
  </View><Text style={styles.detail}>{copy.files}</Text>
  <View style={styles.pinned}>
   <PinnedRow testID="threads-pinned-equipment" label={threadsCopy.pinnedEquipment} detail={threadsCopy.pinnedEquipmentDetail} icon={<Calendar color={colors.sageText}/>} onPress={()=>router.push('/equipment')}/>
   <PinnedRow testID="threads-pinned-team" label={threadsCopy.pinnedTeam} detail={threadsCopy.pinnedTeamDetail} icon={<People color={colors.muted}/>} last/>
  </View>
  {busy?<Text testID="threads-loading" style={styles.body}>{copy.loading}</Text>:null}
  {state.message?<View style={styles.statusRow}><Text testID="threads-status" role="status" style={[styles.body,{flex:1}]}>{state.message}</Text>{state.phase==='failed'?<ThreadAction testID="threads-refresh" label="Try again" disabled={busy||waiting} onPress={()=>{void controls.load();}}/>:null}</View>:null}
  {paused?<Text style={styles.body}>{copy.paused}</Text>:null}
  {state.data?.available&&state.data.threads.length===0?<Text testID="threads-empty" style={styles.body}>{copy.empty}</Text>:null}
  {state.data?groupedRows(state.data).map(({group,rows})=><View key={group.key} style={{marginTop:16}}>
   <Pressable testID={`thread-group-${group.key}`} role="button" aria-expanded={!folds.has(group.key)} onPress={()=>toggle(group.key)} style={styles.group}>
    <Text style={styles.groupLabel} numberOfLines={1}>{folds.has(group.key)?'›':'⌄'} {group.label}</Text><Text style={styles.detail}>{group.threads} threads · {group.needsYou} need you</Text>
   </Pressable>
   {group.owner||group.startsOn||group.endsOn?<Text style={styles.detail}>{[group.owner?.name,groupDates(group.startsOn,group.endsOn)].filter(Boolean).join(' · ')}</Text>:null}
   {!folds.has(group.key)&&rows.length?<View style={styles.groupCard}>{rows.map((row,i)=><ThreadRow key={row.id} row={row} last={i===rows.length-1}/>)}</View>:null}
   {!folds.has(group.key)&&rows.length===0?<Text style={styles.detail}>Load more threads to see this group.</Text>:null}
  </View>):null}
  {state.data?.nextCursor?<ThreadAction testID="threads-more" label="Show more" disabled={busy||waiting} onPress={()=>{void controls.load(true);}}/>:null}
 </ScrollView><View style={{position:'absolute',right:16,bottom:16}}><Button testID="threads-new" label="New thread" primary disabled={state.phase==='lost'} onPress={()=>router.push('/threads/new')}/></View></View>}/>;
}
function ThreadRow({row,last}:{row:Row;last:boolean}){
 return <Pressable testID={`thread-row-${row.id}`} onPress={()=>router.push(`/threads/${row.id}`)} role="link" style={[styles.threadRow,last&&{borderBottomWidth:0}]}>
  <View style={styles.line}><Text style={[styles.threadTitle,row.needsYou&&{fontWeight:'700'}]} numberOfLines={1}>{row.title}</Text><Text style={styles.time}>{row.lastMessageAt?new Date(row.lastMessageAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'No messages'}</Text></View>
  <Text style={styles.facts} numberOfLines={1}>{[row.status,...row.facts].filter(Boolean).join(' · ')}</Text>
  <View style={styles.line}><Text style={styles.preview} numberOfLines={1}>{row.lastMessage?`${firstName(row.lastMessage.authorName)}: ${row.lastMessage.excerpt}`:'No messages yet'}</Text>{row.needsYou?<Text testID={`thread-unread-${row.id}`} accessibilityLabel={row.unread?`${unreadLabel(row.unread)} unread`:'Needs you'} style={styles.pip}>{row.unread?unreadLabel(row.unread):'•'}</Text>:null}</View>
 </Pressable>;
}

/** A pinned row opens a view that is not a list of threads. One without `onPress` is listed but not available. */
function PinnedRow({ testID, label, detail, icon, onPress, last = false }: { testID: string; label: string; detail: string; icon: React.ReactNode; onPress?: () => void; last?: boolean }) {
	const content = (
		<>
			<View style={styles.icon}>{icon}</View>
			<View style={styles.text}>
				<Text style={[styles.label, onPress ? null : styles.unavailable]}>{label}</Text>
				<Text style={styles.detail}>{detail}</Text>
			</View>
			{onPress ? <ChevronRight color={colors.muted} /> : null}
		</>
	);
	const style = [styles.row, last ? styles.lastRow : null];
	if (!onPress) return <View testID={testID} style={style} accessible aria-label={`${label}. ${detail}`} aria-disabled>{content}</View>;
	return <Pressable testID={testID} style={style} onPress={onPress} role="link" aria-label={`${label}. ${detail}`}>{content}</Pressable>;
}

const styles = StyleSheet.create({
 statusRow:{flexDirection:'row',alignItems:'center',gap:8},group:{minHeight:36,flexDirection:'row',alignItems:'center',gap:8},groupLabel:{flex:1,fontSize:15,fontWeight:'600',color:colors.heading},groupCard:{borderWidth:1,borderColor:colors.rowLine,borderRadius:12,overflow:'hidden',marginTop:6,backgroundColor:colors.card},threadRow:{borderBottomWidth:1,borderColor:colors.rowLine,paddingHorizontal:12,paddingVertical:8,backgroundColor:colors.card},line:{flexDirection:'row',alignItems:'center',gap:8},threadTitle:{flex:1,minWidth:0,fontSize:14,fontWeight:'500',color:colors.heading},time:{fontSize:11,color:colors.muted},facts:{fontSize:12,color:colors.sageText,marginTop:3},preview:{flex:1,minWidth:0,fontSize:13,color:colors.muted,marginTop:3},pip:{fontSize:11,fontWeight:'600',minWidth:17,textAlign:'center',borderRadius:9,paddingHorizontal:4,backgroundColor:colors.sageText,color:colors.card},
	body: { fontSize: type.body, lineHeight: 21, color: colors.body },
	filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 },
	filter: { minHeight: space.minTarget, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
	filterOn: { backgroundColor: colors.sage, borderColor: colors.sage },
	filterText: { fontSize: 14, color: colors.body },
	filterTextOn: { fontWeight: '600', color: colors.sageText },
	pinned: { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.line, overflow: 'hidden', marginBottom: 14 },
	row: { minHeight: space.rowMinHeight, padding: space.rowPadding, flexDirection: 'row', gap: 12, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.rowLine },
	lastRow: { borderBottomWidth: 0 },
	icon: { width: 32, height: 32, borderRadius: 11, backgroundColor: colors.sage, alignItems: 'center', justifyContent: 'center' },
	text: { flex: 1, minWidth: 0 },
	label: { fontSize: type.rowTitle, fontWeight: '600', color: colors.heading },
	unavailable: { color: colors.muted },
	detail: { marginTop: 2, fontSize: type.rowDetail, lineHeight: type.rowDetailLine, color: colors.muted }
});
