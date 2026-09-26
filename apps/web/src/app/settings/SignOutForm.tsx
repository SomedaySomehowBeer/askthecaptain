'use client';

import { purgeForUser } from '../chat/pending.ts';

/** Clear this person's tab-local chat drafts before ending the authenticated session. */
export function SignOutForm({ userId }: { userId: string }) {
 return <form action="/auth/sign-out" method="post" onSubmit={() => {
  try { purgeForUser(window.sessionStorage, userId); } catch { /* Storage may be disabled; sign-out must still work. */ }
 }}><button className="button button--ghost" type="submit">Sign out</button></form>;
}
