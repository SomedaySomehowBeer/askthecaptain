import { Suspense, version } from 'react';
import { requireLocalRepro } from './guard.ts';
import { ReproForm } from './ReproForm.tsx';
import { plain } from './actions.ts';
import { SyncPingProbe } from './SyncPingProbe.tsx';
export const dynamic = 'force-dynamic';
async function Forms({ n, refresh }: { n: number; refresh: boolean }) {
 await Promise.resolve();
 return <section>{Array.from({ length: n }, (_, i) => <form action={plain.bind(null, i, refresh)} key={i}><input type="hidden" name="id" value={i}/><button type="submit">Plain action {i}</button></form>)}</section>;
}
export default async function PendingRepro({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
 requireLocalRepro(); const query = await searchParams; const n = Math.max(0, Math.min(500, Math.trunc(Number(query.n) || 0))), refresh = query.refresh !== '0';
 if (query.sync === '1') return <main><h1>Pending transition reproduction</h1><SyncPingProbe/></main>;
 const forms = <Forms n={n} refresh={refresh}/>;
 return <main><h1>Pending transition reproduction</h1><p>Server React: {version}; {n} plain forms; revalidatePath: {String(refresh)}</p><ReproForm refresh={refresh}/>{query.suspense === '1' ? <Suspense fallback={<p>Loading forms</p>}>{forms}</Suspense> : forms}</main>;
}
