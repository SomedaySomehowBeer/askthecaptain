import Link from 'next/link';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { api, load, type Organisation } from '../../../lib/api.ts';
import { Timeline, type Lane } from './Timeline.tsx';
import type { EquipmentPage, ReservationRange } from './types.ts';
import { isScale } from './geometry.ts';
import { shiftDate, todayInZone, zonedDay } from './time.ts';
export const metadata = { title: 'Equipment schedule' };
type Query = { date?: string | string[]; span?: string | string[]; offset?: string | string[]; scale?: string | string[] };
export default async function EquipmentSchedule({ searchParams }: { searchParams: Promise<Query> }) {
 const me = await requireCurrent('/resources/equipment');
 const base = `/v1/organisations/${me.organisation.organisationId}`;
 const organisation = await load(() => api<Organisation>(base, { token: me.token }));
 if (!organisation.ok) return <Page title="Equipment"><Notice tone="failed" title="The schedule could not be read.">The business time zone is unavailable. Refresh to try again; availability is unknown.</Notice></Page>;
 const zone = organisation.value.timezone, query = await searchParams;
 let date: string, from: string, to: string, span: number, offset: number;
 const scale = typeof query.scale === 'string' && isScale(query.scale) ? query.scale : 'days';
 try {
  date = query.date === undefined ? todayInZone(zone) : typeof query.date === 'string' ? query.date : '';
  span = query.span === undefined ? 14 : typeof query.span === 'string' && /^(1|7|14|28)$/.test(query.span) ? Number(query.span) : NaN;
  offset = query.offset === undefined ? 0 : typeof query.offset === 'string' && /^\d+$/.test(query.offset) ? Number(query.offset) : NaN;
  if (!Number.isFinite(span) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw Error();
  from = zonedDay(date, zone); to = zonedDay(shiftDate(date, span), zone);
 } catch { return <Page title="Equipment"><Notice tone="attention" title="Choose a valid schedule window." action={{ href: '/resources/equipment', label: 'Open today’s schedule' }}>Use a date between 1900 and 2200, a 1, 7, 14 or 28 day window and a valid equipment page.</Notice></Page>; }
 const catalogue = await load(() => api<EquipmentPage>(`${base}/equipment?limit=8&offset=${offset}`, { token: me.token }));
 if (!catalogue.ok) return <Page title="Equipment"><Notice tone="failed" title="Equipment could not be loaded.">{catalogue.error.message} Refresh to try again. Availability is unknown.</Notice><Link href="/resources/equipment/manage">Manage equipment</Link></Page>;
 const lanes: Lane[] = await Promise.all(catalogue.value.equipment.map(async equipment => {
  const params = new URLSearchParams({ from, to });
  const result = await load(() => api<ReservationRange>(`${base}/equipment/${equipment.id}/reservations?${params}`, { token: me.token }));
  return { equipment, result: result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message } };
 }));
 return <Page title="Equipment" lede={`Shared availability · ${zone}`}>
  <Timeline key={`${date}:${span}:${offset}`} lanes={lanes} date={date} span={span} from={from} to={to} zone={zone} initialScale={scale} offset={offset} nextOffset={catalogue.value.nextOffset} />
 </Page>;
}
