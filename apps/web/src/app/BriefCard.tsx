import Link from 'next/link';
import { Notice } from '../components/Notice.tsx';
import type { requireCurrent } from '../components/Page.tsx';
import { api, load } from '../lib/api.ts';
type Latest = { today: string; timezone: string; notice: string | null; brief: null | { forDate: string; title: string; lines: string[]; items: { kind: string; id: string; label: string; href: string }[]; producedAt: string } };
export async function BriefCard({ me }: { me: Awaited<ReturnType<typeof requireCurrent>> }) {
 const result = await load(() => api<Latest>(`/v1/organisations/${me.organisation.organisationId}/briefs/latest`, { token: me.token }));
 const value = result.ok ? result.value : null, brief = value?.brief;
 return <section className="card card--inset stack morning-brief" aria-labelledby="brief">
  <h2 id="brief">The brief</h2>
  {!result.ok ? <Notice tone="failed" action={{ href: '/', label: 'Try again' }}>Your morning brief could not be read. {result.error.message}</Notice> : null}
  {value?.notice ? <Notice action={{ href: '/settings/workflows', label: 'Workflows' }}>{value.notice}</Notice> : null}
  {brief ? <>
   {brief.forDate !== value!.today ? <p className="chip">Latest brief is for {brief.forDate}; it is not today’s summary.</p> : null}
   <h3>{brief.title}</h3>
   <p className="muted">Produced <time dateTime={brief.producedAt}>{new Intl.DateTimeFormat('en-AU', { timeZone: value!.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(brief.producedAt))}</time> · {value!.timezone}</p>
   {brief.lines.map((line, n) => <p key={n}>{line}</p>)}
   {brief.items.length ? <ul>{brief.items.map((item, n) => <li key={`${item.kind}:${item.id}:${n}`}><Link href={item.href}>{item.label}</Link></li>)}</ul> : null}
  </> : value ? <p className="secondary">No morning brief has been produced yet. Once enabled, it arrives here and on your phone at 06:30 in your organisation’s timezone.</p> : null}
 </section>;
}
