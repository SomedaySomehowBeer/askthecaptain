 'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export function LegacyWorkLink(){const router=useRouter();useEffect(()=>{const hash=window.location.hash;const match=/^#(task|project)-([0-9a-f-]{36})$/i.exec(hash);router.replace(match?`/work/${match[1]==='task'?'tasks':'projects'}/${match[2]}`:hash==='#new-project'?'/work/projects/new':'/work');},[router]);return <p role="status">Opening Work…</p>;}
