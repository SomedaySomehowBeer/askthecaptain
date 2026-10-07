import { clockTime, groupDates, ThreadAction } from '../threads/Presentation.tsx';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createListControls } from '../threads/list-controls.ts';
import { filters, type Row } from '../threads/contracts.ts';
import { groupedRows, firstName, unreadLabel } from '../threads/derive.ts';
import { foldedGroups, saveFolds } from '../threads/storage.ts';
import { useThreadPoll, useDeadline } from '../threads/use-poll.ts';
import { copy } from '../threads/copy.ts';
import type { ThreadCalls } from '../threads/api.ts';
import type { ReadScope } from '../account/contracts.ts';
import { Redirect, router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useAccount } from '../account/AccountProvider.tsx';
import { isSignedIn, threadsCopy, webCopy } from '../account/copy.ts';
import { Calendar, ChevronDown, People, Plus, ThreadKindIcon } from '../components/Icons.tsx';
import { PlainScreen, Screen } from '../components/Screen.tsx';
import Welcome from './welcome.tsx';
import { faces, space, type } from '../theme/tokens.ts';
import { themedStyles, useTheme } from '../theme/theme.ts';

/** The one scoped list of threads; account guards resolve before any thread read. */
export default function Home() {
	const styles = useStyles();
	const { colors } = useTheme();
	const { snapshot, web, now } = useAccount();
	const account = snapshot.account;
	if (account.kind === 'checking' || account.kind === 'starting') {
		return <PlainScreen title="Captain" back={null}><Text testID="shell-checking" style={styles.body}>{webCopy.checking}</Text></PlainScreen>;
	}
	if (account.kind === 'unverified') return <Welcome />;
	if (!isSignedIn(account)) return <Redirect href="/welcome" />;
	if (account.org.kind !== 'chosen') return <Redirect href="/organisation" />;
	if(!web||!account.scope)return <Screen title={threadsCopy.heading}><View style={styles.pinned}><PinnedRow testID="threads-pinned-equipment" label={threadsCopy.pinnedEquipment} detail={threadsCopy.pinnedEquipmentDetail} icon={<Calendar color={colors.sageText}/>} onPress={()=>router.push('/equipment')}/><PinnedRow testID="threads-pinned-team" label={threadsCopy.pinnedTeam} detail={threadsCopy.pinnedTeamDetail} icon={<People color={colors.muted}/>}/></View><Text testID="threads-empty" style={styles.body}>{copy.unavailable}</Text></Screen>;
 return <ThreadList key={account.scope.epoch} calls={web.threads} scope={account.scope} now={now} />;
}
function ThreadList({calls,scope,now}:{calls:ThreadCalls;scope:ReadScope;now:()=>number}){
 const styles = useStyles();
 const { colors } = useTheme();
 const [controls]=useState(()=>createListControls(calls,scope,now));
 const state=useSyncExternalStore(controls.subscribe,controls.snapshot,controls.snapshot);
 const [folds,setFolds]=useState(foldedGroups);
 useEffect(()=>{void controls.load();return()=>controls.dispose();},[controls]);
 const paused=useThreadPoll(()=>controls.load(),now),waiting=useDeadline(state.waitUntil,now);
 const busy=state.phase==='loading';
 const toggle=(key:string)=>{const next=new Set(folds);if(next.has(key))next.delete(key);else next.add(key);setFolds(next);saveFolds(next);};
 return <Screen title={threadsCopy.heading} list={({heading,contentContainerStyle})=><View style={{flex:1}}><ScrollView testID="threads-list" contentContainerStyle={[contentContainerStyle,styles.listContent]}>
  {heading}
  <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="threads-filters" style={styles.filterScroll} contentContainerStyle={styles.filters}><View role="radiogroup" aria-label={threadsCopy.filterGroup} style={styles.filters}>
   {threadsCopy.filters.map((filter,index)=><Pressable key={filter} testID={`threads-filter-${index}`} disabled={index>5||busy||waiting} aria-disabled={index>5||busy||waiting} role="radio" aria-checked={state.filter===filters[index]} aria-label={filter} accessibilityHint={index>5?copy.files:undefined} onPress={()=>{void controls.filter(filters[index]!);}} style={styles.filter}><View style={[styles.filterChip,state.filter===filters[index]&&styles.filterOn]}><Text style={[styles.filterText,state.filter===filters[index]&&styles.filterTextOn]}>{filter}</Text></View></Pressable>)}
  </View></ScrollView>{state.filter==='files'||state.filter==='people'?<Text style={styles.detail}>{copy.files}</Text>:null}
  <View style={styles.pinned}>
   <PinnedRow testID="threads-pinned-equipment" label={threadsCopy.pinnedEquipment} detail={threadsCopy.pinnedEquipmentDetail} icon={<Calendar color={colors.sageText}/>} onPress={()=>router.push('/equipment')}/>
   <PinnedRow testID="threads-pinned-team" label={threadsCopy.pinnedTeam} detail={threadsCopy.pinnedTeamDetail} icon={<People color={colors.muted}/>}/>
  </View>
  {busy?<Text testID="threads-loading" style={styles.body}>{copy.loading}</Text>:null}
  {state.message?<View style={styles.statusRow}><Text testID="threads-status" role="status" style={[styles.body,{flex:1}]}>{state.message}</Text>{state.phase==='failed'?<ThreadAction testID="threads-refresh" label="Try again" disabled={busy||waiting} onPress={()=>{void controls.load();}}/>:null}</View>:null}
  {paused?<Text style={styles.body}>{copy.paused}</Text>:null}
  {state.data?.available&&state.data.threads.length===0?<Text testID="threads-empty" style={styles.body}>{copy.empty}</Text>:null}
  {state.data?groupedRows(state.data).map(({group,rows})=><View key={group.key} style={styles.groupBox}>
   <Pressable testID={`thread-group-${group.key}`} role="button" aria-expanded={!folds.has(group.key)} onPress={()=>toggle(group.key)} style={styles.group}>
    <View style={folds.has(group.key)?styles.shut:null}><ChevronDown color={colors.muted} size={7}/></View><Text style={styles.groupLabel} numberOfLines={1}>{group.label}</Text><Text style={styles.groupMeta} numberOfLines={1}>{[group.owner?.name,groupDates(group.startsOn,group.endsOn),`${group.threads} ${group.threads===1?'thread':'threads'}`].filter(Boolean).join(' · ')}</Text>{group.needsYou>0?<Text style={styles.pip} accessibilityLabel={`${group.needsYou} need you`}>{group.needsYou}</Text>:null}
   </Pressable>
   {!folds.has(group.key)&&rows.length?<View style={styles.rows}>{rows.map(row=><ThreadRow key={row.id} row={row}/>)}</View>:null}
   {!folds.has(group.key)&&rows.length===0?<Text style={styles.detail}>Load more threads to see this group.</Text>:null}
  </View>):null}
  {state.data?.nextCursor?<ThreadAction testID="threads-more" label="Show more" disabled={busy||waiting} onPress={()=>{void controls.load(true);}}/>:null}
 </ScrollView><View style={styles.newWrap}><Pressable testID="threads-new" role="button" aria-label="New thread" aria-disabled={state.phase==='lost'} disabled={state.phase==='lost'} onPress={state.phase==='lost'?undefined:()=>router.push('/threads/new')} style={[styles.new,state.phase==='lost'&&styles.newOff]}><Plus color={colors.actionText}/><Text style={styles.newText}>New thread</Text></Pressable></View></View>}/>;
}
function ThreadRow({row}:{row:Row}){
 const styles = useStyles();
 const { colors } = useTheme();
 return <Pressable testID={`thread-row-${row.id}`} onPress={()=>router.push(`/threads/${row.id}`)} role="link" style={[styles.threadRow,row.needsYou&&{backgroundColor:colors.needsYou,borderColor:colors.needsYouLine}]}>
  <View style={styles.icon}><ThreadKindIcon kind={row.record?.kind??row.kind} color={colors.sageText}/></View><View style={styles.text}>
  <View style={styles.line}><Text style={styles.threadTitle} numberOfLines={1}>{row.title}</Text><Text style={styles.time}>{row.lastMessageAt?clockTime(row.lastMessageAt):'No messages'}</Text></View>
  <Text style={[styles.facts,row.status==='Pending'&&styles.pending]} numberOfLines={1}>{[row.status,...row.facts].filter(Boolean).join(' · ')}</Text>
  <View style={styles.line}><Text style={styles.preview} numberOfLines={1}>{row.lastMessage?`${firstName(row.lastMessage.authorName)}: ${row.lastMessage.excerpt}`:'No messages yet'}</Text>{row.needsYou?<Text testID={`thread-unread-${row.id}`} accessibilityLabel={row.unread?`${unreadLabel(row.unread)} unread`:'Needs you'} style={styles.pip}>{row.unread?unreadLabel(row.unread):'•'}</Text>:null}</View></View>
 </Pressable>;
}

/** A pinned row opens a view that is not a list of threads. One without `onPress` is listed but not available. */
function PinnedRow({ testID, label, detail, icon, onPress }: { testID: string; label: string; detail: string; icon: React.ReactNode; onPress?: () => void }) {
 const styles = useStyles();
 const { colors } = useTheme();
 const content = <><View aria-hidden style={styles.pinIcon}>{icon}</View><Text numberOfLines={1} style={[styles.label,!onPress&&styles.unavailable]}>{label}</Text></>;
 const style = [styles.row,!onPress&&{backgroundColor:colors.page,borderColor:colors.line}];
	if (!onPress) return <View testID={testID} style={style} accessible aria-label={`${label}. ${detail}`} aria-disabled>{content}</View>;
	return <Pressable testID={testID} style={style} onPress={onPress} role="link" aria-label={`${label}. ${detail}`}>{content}</Pressable>;
}

/** Prototype frame 1 (dark: frame 15), measured at 390 px: 10 pt list gutter, 44 pt filter targets around 26 pt chips,
 *  two pinned views side by side, Fraunces group headings, dense rows (13/11/12 pt) with a 26 pt kind tile, and the
 *  pill "New thread" button with its plus. */
const useStyles = themedStyles((colors) => ({
 listContent:{paddingHorizontal:10,paddingBottom:84},
 statusRow:{flexDirection:'row',alignItems:'center',gap:8},
 groupBox:{marginTop:6},
 group:{minHeight:44,flexDirection:'row',alignItems:'center',gap:6,paddingLeft:2,paddingRight:6},
 shut:{transform:[{rotate:'-90deg'}]},
 groupLabel:{maxWidth:'44%',flexShrink:1,fontFamily:faces.display,fontSize:type.groupTitle,lineHeight:type.groupTitleLine,color:colors.heading},
 groupMeta:{flex:1,minWidth:0,fontSize:type.tiny,color:colors.muted},
 rows:{gap:2},
 threadRow:{flexDirection:'row',alignItems:'flex-start',gap:9,borderWidth:1,borderRadius:10,borderColor:colors.rowLine,paddingHorizontal:10,paddingVertical:7,minHeight:44,backgroundColor:colors.card},
 line:{flexDirection:'row',alignItems:'center',gap:8},
 threadTitle:{flex:1,minWidth:0,fontSize:type.rowTitle,lineHeight:type.rowTitleLine,fontWeight:'700',color:colors.heading},
 time:{fontSize:type.tiny,lineHeight:type.rowTitleLine,color:colors.muted},
 facts:{fontSize:type.rowDetail,lineHeight:type.rowDetailLine,fontWeight:'600',color:colors.sageText,marginTop:1},
 pending:{color:colors.warningText},
 preview:{flex:1,minWidth:0,fontSize:type.rowLast,lineHeight:type.rowLastLine,color:colors.muted,marginTop:1},
 pip:{fontSize:type.tiny,lineHeight:17,fontWeight:'700',minWidth:17,height:17,textAlign:'center',borderRadius:9,paddingHorizontal:5,backgroundColor:colors.action,color:colors.actionText,overflow:'hidden'},
	body: { fontSize: type.body, lineHeight: type.bodyLine, color: colors.body },
	filterScroll: { flexGrow: 0, marginHorizontal: -10 },
	filters: { flexDirection: 'row', gap: 2, paddingHorizontal: 5 },
	filter: { minHeight: space.minTarget, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center' },
	filterChip: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 15, borderWidth: 1, borderColor: colors.fieldLine, backgroundColor: colors.card },
	filterOn: { backgroundColor: colors.body, borderColor: colors.body },
	filterText: { fontSize: type.label, lineHeight: 16, fontWeight: '700', color: colors.muted },
	filterTextOn: { color: colors.page },
 pinned: { flexDirection:'row',gap:6,paddingTop:2,marginBottom:8 },
 row: { flex:1,flexBasis:0,minWidth:0,minHeight:44,paddingHorizontal:10,flexDirection:'row',gap:6,alignItems:'center',borderWidth:1,borderColor:colors.needsYouLine,borderRadius:12,backgroundColor:colors.pinned },
 pinIcon: { width:15,height:15,alignItems:'center',justifyContent:'center',transform:[{scale:0.85}] },
 icon: { width:26,height:26,borderRadius:8,marginTop:2,backgroundColor:colors.sage,alignItems:'center',justifyContent:'center' },
	text: { flex: 1, minWidth: 0 },
	label: { flexShrink:1,fontSize:type.label, fontWeight: '700', color: colors.body },
	unavailable: { color: colors.muted },
	detail: { marginTop: 2, fontSize: type.small, lineHeight: type.smallLine, color: colors.muted },
	newWrap: { position: 'absolute', right: 14, bottom: 18 },
	new: { minHeight: 48, paddingLeft: 14, paddingRight: 18, borderRadius: 24, backgroundColor: colors.action, flexDirection: 'row', alignItems: 'center', gap: 7, shadowColor: colors.shadow, shadowOpacity: 0.25, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
	newOff: { opacity: 0.45 },
	newText: { fontSize: type.rowTitle, fontWeight: '700', color: colors.actionText }
}));
