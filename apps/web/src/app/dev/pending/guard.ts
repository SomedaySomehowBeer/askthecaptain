import { notFound } from 'next/navigation';
/** Diagnostic only. Both the page and action entry points reject production. */
export function requireLocalRepro() {
 if (process.env.NODE_ENV === 'production' || process.env.CAPTAIN_REPRO_LOCAL !== '1') notFound();
 const origin = new URL(process.env.APP_URL ?? 'http://localhost:3000');
 if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) notFound();
}
