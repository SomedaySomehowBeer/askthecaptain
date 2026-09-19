'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
/** Re-reads the page while something is happening on the runtime, so the sign-in link and outcome appear without a manual refresh. */
export function Refresh({ everyMs }: { everyMs: number }) {
 const router = useRouter();
 useEffect(() => { const id = setInterval(() => router.refresh(), everyMs); return () => clearInterval(id); }, [router, everyMs]);
 return null;
}
