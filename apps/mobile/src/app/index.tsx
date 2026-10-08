import { clockTime, groupDates, ThreadAction } from '../threads/Presentation.tsx';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { createListControls } from '../threads/list-controls.ts';
import { filters, type Row } from '../threads/contracts.ts';
import { groupedRows, firstName, unreadLabel } from '../threads/derive.ts';
import { foldedGroups, saveFolds } from '../threads/storage.ts';
import { useThreadPoll, useDeadline } from '../threads/use-poll.ts';
import { copy } from '../threads/copy.ts';
import type { ThreadCalls } from '../threads/api.ts';
import type { ReadScope } from '../account/contracts.ts';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { parseStockList, stockListPath } from '../resources/stock/stock.ts';
import { stocktakeFlash } from '../resources/stock/stocktake.ts';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useAccount } from '../account/AccountProvider.tsx';
import { isSignedIn, threadsCopy, webCopy } from '../account/copy.ts';
import { Calendar, ChevronDown, Magnifier, People, Plus, ThreadKindIcon } from '../components/Icons.tsx';
import { createSearch, excerptParts, resultsWords, searchCopy, type Match, type SearchState } from '../threads/search.ts';
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
	if(!web||!account.scope)return <Screen title={threadsCopy.heading}><View style={styles.pinned}><PinnedRow testID="threads-pinned-equipment" label={threadsCopy.pinnedEquipment} detail={threadsCopy.pinnedEquipmentDetail} icon={<Calendar color={colors.sageText}/>} onPress={()=>router.push('/equipment')}/><PinnedRow testID="threads-pinned-team" label={threadsCopy.pinnedTeam} detail={threadsCopy.pinnedTeamDetail} icon={<People color={colors.sageText}/>} onPress={()=>router.push('/members?from=threads' as never)}/></View><Text testID="threads-empty" style={styles.body}>{copy.unavailable}</Text></Screen>;
 return <ThreadList key={account.scope.epoch} calls={web.threads} scope={account.scope} now={now} />;
}
function ThreadList({calls,scope,now}:{calls:ThreadCalls;scope:ReadScope;now:()=>number}){
 const styles = useStyles();
 const { colors } = useTheme();
 const [controls]=useState(()=>createListControls(calls,scope,now));
 const state=useSyncExternalStore(controls.subscribe,controls.snapshot,controls.snapshot);
 // Search (H4): the header's magnifier opens the field; results replace the grouped list, and polling pauses meanwhile.
 const [search]=useState(()=>createSearch(calls,scope,{now,set:(fn,ms)=>setTimeout(fn,ms),clear:h=>clearTimeout(h as ReturnType<typeof setTimeout>)}));
 const found=useSyncExternalStore(search.subscribe,search.snapshot,search.snapshot);
 useEffect(()=>()=>search.dispose(),[search]);
 useEffect(()=>{search.filter(state.filter);},[state.filter]);
 const searching=search.active();
 const [folds,setFolds]=useState(foldedGroups);
 const [menu,setMenu]=useState<string|null>(null);
 useEffect(()=>{void controls.load();return()=>controls.dispose();},[controls]);
 const paused=useThreadPoll(()=>search.active()?Promise.resolve():controls.load(),now),waiting=useDeadline(state.waitUntil,now),searchWaiting=useDeadline(found.waitUntil,now);
 const busy=state.phase==='loading';
 // The Stock filter's pinned Stocktake row says how many active items there are (stock contract §3): read when the filter turns on.
 const [stockItems,setStockItems]=useState<number|null>(null);
 useEffect(()=>{if(state.filter!=='stock')return;let live=true;setStockItems(null);void calls.request(scope,'GET',stockListPath(scope),undefined,v=>parseStockList(v,false)).then(r=>{if(live&&r.kind==='ok')setStockItems(r.value.items.length);});return()=>{live=false;};},[state.filter]);
 // A saved stocktake says so here, once, and the rows reload with the new counts.
 const [saved,setSaved]=useState<string|null>(null);
 useFocusEffect(useCallback(()=>{const line=stocktakeFlash.take(scope);if(line){setSaved(line);void controls.load();}},[controls,scope]));
 const toggle=(key:string)=>{const next=new Set(folds);if(next.has(key))next.delete(key);else next.add(key);setFolds(next);saveFolds(next);};
 const openTags=(href:string)=>{setMenu(null);router.push(href as never);};
 return <Screen title={threadsCopy.heading} search={{open:found.open,onPress:()=>{if(found.open)search.close();else search.open();}}} list={({heading,contentContainerStyle})=><View style={{flex:1}}><ScrollView testID="threads-list" contentContainerStyle={[contentContainerStyle,styles.listContent]}>
  {heading}
  {found.open?<SearchField text={found.text} onChange={t=>search.type(t)} onClear={()=>search.close()}/>:null}
  <View style={styles.filterRow}><ScrollView horizontal showsHorizontalScrollIndicator={false} testID="threads-filters" style={styles.filterScroll} contentContainerStyle={styles.filters}><View role="radiogroup" aria-label={threadsCopy.filterGroup} style={styles.filters}>
   {threadsCopy.filters.map((filter,index)=><Pressable key={filter} testID={`threads-filter-${index}`} disabled={index>5||busy||waiting} aria-disabled={index>5||busy||waiting} role="radio" aria-checked={state.filter===filters[index]} aria-label={filter} accessibilityHint={index>5?copy.files:undefined} onPress={()=>{void controls.filter(filters[index]!);}} style={styles.filter}><View style={[styles.filterChip,state.filter===filters[index]&&styles.filterOn]}><Text style={[styles.filterText,state.filter===filters[index]&&styles.filterTextOn]}>{filter}</Text></View></Pressable>)}
  </View></ScrollView>
   <Pressable testID="threads-more-actions" role="button" aria-label={threadsCopy.more} aria-expanded={menu==='list'} onPress={()=>setMenu(menu==='list'?null:'list')} style={styles.moreButton}><MoreDots color={colors.body}/></Pressable></View>
  {menu==='list'?<View testID="threads-list-menu" role="menu" style={styles.menu}><Pressable testID="threads-manage-tags" role="menuitem" onPress={()=>openTags('/tags')} style={styles.menuItem}><Text style={styles.menuText}>{threadsCopy.manageTags}</Text></Pressable></View>:null}
  {state.filter==='files'||state.filter==='people'?<Text style={styles.detail}>{copy.files}</Text>:null}
  {searching?<SearchResults state={found} waiting={searchWaiting} onRetry={()=>search.retry()}/>:<>
  <View style={styles.pinned}>
   <PinnedRow testID="threads-pinned-equipment" label={threadsCopy.pinnedEquipment} detail={threadsCopy.pinnedEquipmentDetail} icon={<Calendar color={colors.sageText}/>} onPress={()=>router.push('/equipment')}/>
   <PinnedRow testID="threads-pinned-team" label={threadsCopy.pinnedTeam} detail={threadsCopy.pinnedTeamDetail} icon={<People color={colors.sageText}/>} onPress={()=>router.push('/members?from=threads' as never)}/>
  </View>
  {state.filter==='stock'?<View style={styles.pinned}><PinnedRow testID="threads-pinned-stocktake" label={threadsCopy.pinnedStocktake(stockItems)} detail={threadsCopy.pinnedStocktakeDetail} icon={<ThreadKindIcon kind="stock" color={colors.sageText}/>} onPress={()=>router.push('/stock/stocktake' as never)}/></View>:null}
  {saved?<Text testID="threads-stocktake-saved" role="status" style={styles.body}>{saved}</Text>:null}
  {busy?<Text testID="threads-loading" style={styles.body}>{copy.loading}</Text>:null}
  {state.message?<View style={styles.statusRow}><Text testID="threads-status" role="status" style={[styles.body,{flex:1}]}>{state.message}</Text>{state.phase==='failed'?<ThreadAction testID="threads-refresh" label="Try again" disabled={busy||waiting} onPress={()=>{void controls.load();}}/>:null}</View>:null}
  {paused?<Text style={styles.body}>{copy.paused}</Text>:null}
  {state.data?.available&&state.data.threads.length===0?<Text testID="threads-empty" style={styles.body}>{copy.empty}</Text>:null}
  {state.data?groupedRows(state.data).map(({group,rows})=><View key={group.key} style={styles.groupBox}>
   <View style={styles.groupLine}>
   <Pressable testID={`thread-group-${group.key}`} role="button" aria-expanded={!folds.has(group.key)} onPress={()=>toggle(group.key)} onLongPress={group.key==='none'?undefined:()=>setMenu(group.key)} style={styles.group}>
    <View style={folds.has(group.key)?styles.shut:null}><ChevronDown color={colors.muted} size={7}/></View><Text style={styles.groupLabel} numberOfLines={1}>{group.label}</Text><Text style={styles.groupMeta} numberOfLines={1}>{[group.owner?.name,groupDates(group.startsOn,group.endsOn),`${group.threads} ${group.threads===1?'thread':'threads'}`].filter(Boolean).join(' · ')}</Text>{group.needsYou>0?<Text style={styles.pip} accessibilityLabel={`${group.needsYou} need you`}>{group.needsYou}</Text>:null}
   </Pressable>
   {group.key==='none'?null:<Pressable testID={`thread-group-menu-${group.key}`} role="button" aria-label={threadsCopy.groupMenu(group.label)} aria-expanded={menu===group.key} onPress={()=>setMenu(menu===group.key?null:group.key)} style={styles.groupMenu}><MoreDots color={colors.muted}/></Pressable>}
   </View>
   {menu===group.key?<View testID={`thread-group-actions-${group.key}`} role="menu" style={styles.menu}>
    <Pressable testID={`thread-group-details-${group.key}`} role="menuitem" onPress={()=>openTags(`/tags/${group.key}`)} style={styles.menuItem}><Text style={styles.menuText}>{threadsCopy.tagDetails}</Text></Pressable>
    <Pressable testID={`thread-group-manage-${group.key}`} role="menuitem" onPress={()=>openTags('/tags')} style={[styles.menuItem,styles.menuDivided]}><Text style={styles.menuText}>{threadsCopy.manageTags}</Text></Pressable>
   </View>:null}
   {!folds.has(group.key)&&rows.length?<View style={styles.rows}>{rows.map(row=><ThreadRow key={row.id} row={row}/>)}</View>:null}
   {!folds.has(group.key)&&rows.length===0?<Text style={styles.detail}>Load more threads to see this group.</Text>:null}
  </View>):null}
  {state.data?.nextCursor?<ThreadAction testID="threads-more" label="Show more" disabled={busy||waiting} onPress={()=>{void controls.load(true);}}/>:null}
  </>}
 </ScrollView><View style={styles.newWrap}><Pressable testID="threads-new" role="button" aria-label="New thread" aria-disabled={state.phase==='lost'} disabled={state.phase==='lost'} onPress={state.phase==='lost'?undefined:()=>router.push('/threads/new')} style={[styles.new,state.phase==='lost'&&styles.newOff]}><Plus color={colors.actionText}/><Text style={styles.newText}>New thread</Text></Pressable></View></View>}/>;
}
/** A list row; a search result (H4) also has its match: a title match marks the title's words, a message match puts
 *  that message's excerpt, with its words marked, in the preview line. */
function ThreadRow({row,match}:{row:Row;match?:Match}){
 const styles = useStyles();
 const { colors } = useTheme();
 const marked=(text:string)=>excerptParts(text).map((p,i)=>p.mark?<Text key={i} style={styles.mark}>{p.text}</Text>:p.text);
 const preview=match?.kind==='message'?<>{`${firstName(match.authorName)}: `}{marked(match.excerpt)}</>:row.lastMessage?`${firstName(row.lastMessage.authorName)}: ${row.lastMessage.excerpt}`:'No messages yet';
 return <Pressable testID={`thread-row-${row.id}`} onPress={()=>router.push(`/threads/${row.id}`)} role="link" style={[styles.threadRow,row.needsYou&&{backgroundColor:colors.needsYou,borderColor:colors.needsYouLine}]}>
  <View style={styles.icon}><ThreadKindIcon kind={row.record?.kind??row.kind} color={colors.sageText}/></View><View style={styles.text}>
  <View style={styles.line}><Text style={styles.threadTitle} numberOfLines={1}>{match?.kind==='title'?marked(match.excerpt):row.title}</Text><Text style={styles.time}>{row.lastMessageAt?clockTime(row.lastMessageAt):'No messages'}</Text></View>
  <Text style={[styles.facts,row.status==='Pending'&&styles.pending]} numberOfLines={1}>{[row.status,...row.facts].filter(Boolean).join(' · ')}</Text>
  <View style={styles.line}><Text testID={match?`thread-match-${row.id}`:undefined} style={styles.preview} numberOfLines={1}>{preview}</Text>{row.needsYou?<Text testID={`thread-unread-${row.id}`} accessibilityLabel={row.unread?`${unreadLabel(row.unread)} unread`:'Needs you'} style={styles.pip}>{row.unread?unreadLabel(row.unread):'•'}</Text>:null}</View></View>
 </Pressable>;
}

/** The search field under the header (frame 1's magnifier, opened): a labelled input and Clear. */
function SearchField({text,onChange,onClear}:{text:string;onChange:(t:string)=>void;onClear:()=>void}){
 const styles = useStyles();
 const { colors } = useTheme();
 const [focused,setFocused]=useState(false);
 return <View style={styles.searchRow}><View style={[styles.searchBox,focused&&{borderColor:colors.action}]}><Magnifier color={colors.muted}/>
  <TextInput testID="threads-search" autoFocus value={text} onChangeText={onChange} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} placeholder={searchCopy.label} placeholderTextColor={colors.muted}
   aria-label={searchCopy.label} accessibilityHint={searchCopy.hint} maxLength={240} returnKeyType="search" autoCorrect={false} style={styles.searchInput} onKeyPress={e=>{if(e.nativeEvent.key==='Escape')onClear();}}/></View>
  <Pressable testID="threads-search-clear" role="button" aria-label={searchCopy.clear} onPress={onClear} style={styles.searchClear}><Text style={styles.searchClearText}>Clear</Text></Pressable></View>;
}

/** Results in place of the grouped list: "n results" or "No threads match", and the honest states between. */
function SearchResults({state,waiting,onRetry}:{state:SearchState;waiting:boolean;onRetry:()=>void}){
 const styles = useStyles();
 const result=state.phase==='ready'?state.result:null;
 return <View testID="threads-search-results" style={styles.results}>
  {state.phase==='waiting'||state.phase==='loading'?<Text testID="threads-search-status" role="status" style={styles.resultCount}>{searchCopy.searching}</Text>:null}
  {state.phase==='failed'?<View style={styles.statusRow}><Text testID="threads-search-status" role="status" style={[styles.body,{flex:1}]}>{state.message}</Text><ThreadAction testID="threads-search-retry" label="Try again" disabled={waiting} onPress={onRetry}/></View>:null}
  {result&&result.available?<Text testID="threads-search-count" role="status" style={styles.resultCount}>{result.threads.length?resultsWords(result.threads.length):searchCopy.none}</Text>:null}
  {result&&!result.available?<Text testID="threads-search-status" role="status" style={styles.body}>{state.message}</Text>:null}
  {result?.threads.length?<View style={styles.rows}>{result.threads.map(row=><ThreadRow key={row.id} row={row} match={row.match}/>)}</View>:null}
  {result&&result.threads.length===50?<Text style={styles.detail}>{searchCopy.firstFifty}</Text>:null}
 </View>;
}

/** Three dots: a menu of actions. */
function MoreDots({color}:{color:string}){return <View aria-hidden style={{flexDirection:'row',gap:3}}>{[0,1,2].map(i=><View key={i} style={{width:4,height:4,borderRadius:2,backgroundColor:color}}/>)}</View>;}

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
 // H4: the search field (an R3 `.input` with the magnifier), the filter row's overflow and the group heading's menu.
 searchRow:{flexDirection:'row',alignItems:'center',gap:6,marginBottom:4},
 searchBox:{flex:1,flexDirection:'row',alignItems:'center',gap:8,paddingLeft:12,borderWidth:1,borderColor:colors.fieldLine,borderRadius:12,backgroundColor:colors.card},
 searchInput:{flex:1,minWidth:0,minHeight:44,fontSize:type.body,color:colors.heading,outlineWidth:0},
 searchClear:{minHeight:44,minWidth:44,paddingHorizontal:8,alignItems:'center',justifyContent:'center'},
 searchClearText:{fontSize:type.label,fontWeight:'700',color:colors.action},
 results:{gap:6,marginTop:2},
 resultCount:{fontFamily:faces.display,fontSize:type.groupTitle,lineHeight:type.groupTitleLine,color:colors.heading,paddingLeft:2,minHeight:24},
 mark:{fontWeight:'700',color:colors.heading,backgroundColor:colors.sage},
 filterRow:{flexDirection:'row',alignItems:'center'},
 moreButton:{minWidth:44,minHeight:44,alignItems:'center',justifyContent:'center',marginRight:-6},
 groupLine:{flexDirection:'row',alignItems:'center'},
 groupMenu:{minWidth:44,minHeight:44,alignItems:'center',justifyContent:'center',marginRight:-6},
 menu:{alignSelf:'flex-end',minWidth:180,marginBottom:6,borderWidth:1,borderColor:colors.line,borderRadius:12,backgroundColor:colors.card,overflow:'hidden'},
 menuItem:{minHeight:44,paddingHorizontal:14,justifyContent:'center'},
 menuDivided:{borderTopWidth:1,borderColor:colors.rowLine},
 menuText:{fontSize:type.rowTitle,fontWeight:'600',color:colors.heading},
 statusRow:{flexDirection:'row',alignItems:'center',gap:8},
 groupBox:{marginTop:6},
 group:{flex:1,minWidth:0,minHeight:44,flexDirection:'row',alignItems:'center',gap:6,paddingLeft:2,paddingRight:6},
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
	filterScroll: { flexGrow: 1, flexShrink: 1, marginLeft: -10 },
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
