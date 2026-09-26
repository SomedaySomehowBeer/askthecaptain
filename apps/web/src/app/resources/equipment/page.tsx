import Link from 'next/link';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { api, load, type Organisation } from '../../../lib/api.ts';
import { Timeline } from './Timeline.tsx';
import type { EquipmentPage } from './types.ts';
import { isScale } from './geometry.ts';
import { pageSize, type LaneRead } from './loads.ts';
import { readOccupancy } from './occupancy.ts';
import { scheduleRange, type ScheduleRange } from './range.ts';
import { todayInZone } from './time.ts';
export const metadata = { title: 'Equipment schedule' };
// `span` is accepted and ignored: older links chose a fixed window; the schedule now scrolls.
type Query = { date?: string | string[]; span?: string | string[]; offset?: string | string[]; scale?: string | string[] };
export default async function EquipmentSchedule({ searchParams }: { searchParams: Promise<Query> }) {
 const me = await requireCurrent('/resources/equipment');
 const base = `/v1/organisations/${me.organisation.organisationId}`;
 const organisation = await load(() => api<Organisation>(base, { token: me.token }));
 if (!organisation.ok) return <Page title="Equipment"><Notice tone="failed" title="The schedule could not be read.">The business time zone is unavailable. Refresh to try again; availability is unknown.</Notice></Page>;
 const zone = organisation.value.timezone, query = await searchParams;
 const scale = typeof query.scale === 'string' && isScale(query.scale) ? query.scale : 'days';
 let range: ScheduleRange, offset: number;
 try {
  const date = query.date === undefined ? todayInZone(zone) : typeof query.date === 'string' ? query.date : '';
  offset = query.offset === undefined ? 0 : typeof query.offset === 'string' && /^\d+$/.test(query.offset) ? Number(query.offset) : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw Error();
  range = scheduleRange(date, zone);
 } catch { return <Page title="Equipment"><Notice tone="attention" title="Choose a valid schedule date." action={{ href: '/resources/equipment', label: 'Open today’s schedule' }}>Use a date between 1900 and 2200 that exists in {zone}, and a valid equipment page.</Notice></Page>; }
 const catalogue = await load(() => api<EquipmentPage>(`${base}/equipment?limit=${pageSize}&offset=${offset}`, { token: me.token }));
 if (!catalogue.ok) return <Page title="Equipment"><Notice tone="failed" title="Equipment could not be loaded.">{catalogue.error.message} Refresh to try again. Availability is unknown.</Notice><Link href="/resources/equipment/manage">Manage equipment</Link></Page>;
 const equipment = catalogue.value.equipment;
 // The chunk the person opened is read with the page; the rest of the range loads as it scrolls near.
 const chunk = range.chunks[range.anchorChunk]!;
 let initial: Record<string, LaneRead> = {};
 if (equipment.length) {
  const read = await readOccupancy(equipment.map(e => e.id), chunk.from, chunk.to);
  initial = read.ok ? read.lanes : Object.fromEntries(equipment.map(e => [e.id, { ok: false, message: read.error }] as const));
 }
 return <Page title="Equipment" lede={`Shared availability · ${zone}`}>
  <Timeline key={`${range.anchor}:${offset}`} equipment={equipment} range={range} initial={initial} zone={zone} initialScale={scale} offset={offset} nextOffset={catalogue.value.nextOffset} />
 </Page>;
}
