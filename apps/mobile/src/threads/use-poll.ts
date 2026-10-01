import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
/** One timer and one flight per focused screen. No background reads; activity resumes an idle screen. */
export function useThreadPoll(run:()=>Promise<void>,now:()=>number){
 const latest=useRef(run);latest.current=run;const [paused,setPaused]=useState(false);
 useFocusEffect(useCallback(()=>{
  if(typeof document==='undefined')return;
  let live=true,running=false,lastActivity=now(),timer:ReturnType<typeof setTimeout>|null=null;
  const visible=()=>document.visibilityState==='visible'&&document.hasFocus();
  const schedule=()=>{if(timer)clearTimeout(timer);if(live&&visible())timer=setTimeout(()=>{void tick();},15000);};
  const tick=async()=>{if(!live||running||!visible())return;if(now()-lastActivity>=600000){setPaused(true);return;}running=true;try{await latest.current();}finally{running=false;schedule();}};
  const visibility=()=>{if(timer)clearTimeout(timer);if(visible())void tick();};
  const activity=()=>{const idle=now()-lastActivity>=600000;lastActivity=now();setPaused(false);if(idle)void tick();};
  document.addEventListener('visibilitychange',visibility);window.addEventListener('focus',visibility);window.addEventListener('blur',visibility);
  document.addEventListener('pointerdown',activity);document.addEventListener('keydown',activity);document.addEventListener('scroll',activity,true);
  schedule();return()=>{live=false;if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('focus',visibility);window.removeEventListener('blur',visibility);document.removeEventListener('pointerdown',activity);document.removeEventListener('keydown',activity);document.removeEventListener('scroll',activity,true);};
 },[now]));return paused;
}
export function useDeadline(deadline:number,now:()=>number){const [,wake]=useState(0);const delay=Math.max(0,deadline-now());useEffect(()=>{if(!delay)return;const timer=setTimeout(()=>wake(n=>n+1),Math.min(delay,2_147_483_647));return()=>clearTimeout(timer);},[delay]);return delay>0;}
