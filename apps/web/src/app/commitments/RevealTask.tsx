'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/** Work links keep existing task identities. Reveal a completed/archived task before scrolling. */
export function RevealTask() {
 const pathname = usePathname();
 useEffect(() => {
  function reveal() {
   const id = window.location.hash.slice(1);
   if (!/^task-[0-9a-f-]{36}$/i.test(id)) return;
   const target = document.getElementById(id);
   if (!target) return;
   for (let node = target.parentElement; node; node = node.parentElement)
    if (node instanceof HTMLDetailsElement) node.open = true;
   target.scrollIntoView({ block: 'center' });
  }
  reveal(); window.addEventListener('hashchange', reveal);
  return () => window.removeEventListener('hashchange', reveal);
 }, [pathname]);
 return null;
}
