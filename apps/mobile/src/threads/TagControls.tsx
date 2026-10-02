import { useEffect, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import type { ReadScope } from '../account/contracts.ts';
import type { ThreadCalls } from './api.ts';
import type { Detail } from './contracts.ts';
import { createOptions } from './options.ts';
import { useDeadline } from './use-poll.ts';
import { Button } from '../components/AccountPage.tsx';
import { useTheme } from '../theme/theme.ts';
export function TagControls({calls,scope,detail,now,disabled,change}:{calls:ThreadCalls;scope:ReadScope;detail:Detail;now:()=>number;disabled:boolean;change:(id:string,attached:boolean)=>void}){
 const { colors } = useTheme();
 const [controls]=useState(()=>createOptions(calls,scope,'tags',now));
 const state=useSyncExternalStore(controls.subscribe,controls.snapshot,controls.snapshot);
 useEffect(()=>{void controls.load();return()=>controls.dispose();},[controls]);
 const waiting=useDeadline(state.waitUntil,now);
 return <View testID="thread-tags" style={{gap:6,paddingVertical:8}}>
  <Text style={{color:colors.heading}}>Tags</Text>
  {detail.tags.map(t=><Button key={t.id} testID={`tag-remove-${t.id}`} label={`Remove ${t.name}`} disabled={disabled} onPress={()=>change(t.id,false)}/>)}
  {state.busy?<Text testID="tags-loading" style={{ color: colors.plain }}>Loading tags…</Text>:null}
  {state.message?<Text testID="tags-status" role="status" style={{ color: colors.plain }}>{state.message}</Text>:null}
  {state.loaded&&state.rows.length===0?<Text style={{ color: colors.plain }}>No active tags are available.</Text>:null}
  {state.rows.filter(t=>!detail.tags.some(attached=>attached.id===t.id)).map(t=><Button key={t.id} testID={`tag-add-${t.id}`} label={`Add ${t.name}`} disabled={disabled||state.busy||waiting} onPress={()=>change(t.id,true)}/>)}
  <Button testID="tags-refresh" label="Refresh tags" disabled={disabled||state.busy||waiting} onPress={()=>{void controls.load();}}/>
  {state.nextOffset!==null?<Button testID="tags-more" label="More tags" disabled={disabled||state.busy||waiting} onPress={()=>{void controls.load(true);}}/>:null}
 </View>;
}
