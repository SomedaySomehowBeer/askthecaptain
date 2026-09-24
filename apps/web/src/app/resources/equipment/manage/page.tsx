import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '../../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { api, load } from '../../../../lib/api.ts';
import { AddEquipmentForm, EquipmentControls } from '../EquipmentForms.tsx';
import type { EquipmentPage } from '../types.ts';
import '../forms.css';

export const metadata: Metadata = { title: 'Manage equipment' };
const pageSize = 50; const maxOffset = 1_000_000;

function offsetFrom(value: string | string[] | undefined): number | null {
	if (value === undefined || value === '') return 0;
	if (Array.isArray(value) || !/^\d{1,7}$/.test(value)) return null;
	const offset = Number(value);
	return offset <= maxOffset && offset % pageSize === 0 ? offset : null;
}
const href = (archived: boolean, offset: number) => {
	const q = new URLSearchParams(); if (archived) q.set('archived', 'true'); if (offset) q.set('offset', String(offset));
	const text = q.toString(); return text ? `/resources/equipment/manage?${text}` : '/resources/equipment/manage';
};

/** The shared equipment list: add, rename, archive and restore. Each piece is exclusive: one
 *  booking at a time, including maintenance. Archiving waits until nothing is booked ahead. */
export default async function ManageEquipmentPage({ searchParams }: { searchParams: Promise<{ archived?: string | string[]; offset?: string | string[] }> }) {
	const me = await requireCurrent('/resources/equipment/manage');
	const query = await searchParams;
	const archived = query.archived === 'true';
	const offset = offsetFrom(query.offset);
	if ((query.archived !== undefined && query.archived !== 'true' && query.archived !== 'false') || offset === null) {
		return <Page title="Manage equipment"><Notice title="That list does not exist" tone="attention" action={{ href: href(false, 0), label: 'Show current equipment' }}>
			Choose current or archived equipment; pages move in steps of {pageSize}.</Notice></Page>;
	}
	const page = await load(() => api<EquipmentPage>(`/v1/organisations/${me.organisation.organisationId}/equipment?archived=${archived}&limit=${pageSize}&offset=${offset}`, { token: me.token }));
	const next = page.ok && page.value.nextOffset !== null && page.value.nextOffset <= maxOffset ? href(archived, page.value.nextOffset) : null;
	const previous = offset > 0 ? href(archived, Math.max(0, offset - pageSize)) : null;
	return (
		<Page title="Manage equipment" lede="Tanks, lines, rooms or vehicles the team books. Each can hold one reservation at a time, counting setup, cleanup and maintenance.">
			{archived ? null : <section className="card" id="add-equipment"><AddEquipmentForm /></section>}
			<nav className="row equipment-tabs" aria-label="Equipment list">
				<Link className={`chip${archived ? '' : ' chip--project'}`} href={href(false, 0)} aria-current={archived ? undefined : 'page'}>Current</Link>
				<Link className={`chip${archived ? ' chip--project' : ''}`} href={href(true, 0)} aria-current={archived ? 'page' : undefined}>Archived</Link>
				<Link className="equipment-tabs__schedule" href="/resources/equipment">Open the schedule</Link>
			</nav>
			{!page.ok ? (
				<Notice title="Equipment could not be read" tone="failed" action={{ href: href(archived, offset), label: 'Try again' }}>
					{page.error.message}{page.error.requestId ? ` Reference: ${page.error.requestId}` : ''}
				</Notice>
			) : page.value.equipment.length === 0 ? (
				offset > 0 ? <Notice title="Nothing on this page" action={{ href: href(archived, 0), label: 'Back to the first page' }}>The list is shorter than this page.</Notice>
					: archived ? <Notice title="No archived equipment">Archived equipment appears here and can be restored.</Notice>
					: <Notice title="No equipment yet">Add the first piece above, then reserve it from the schedule.</Notice>
			) : (
				<section className="card">
					<ul className="bare equipment-list" aria-label={archived ? 'Archived equipment' : 'Current equipment'}>
						{page.value.equipment.map((item) => (
							<li key={item.id} className="equipment-row">
								<span className="equipment-row__name">{item.name}{item.archivedAt ? <span className="chip">archived</span> : null}</span>
								{item.archivedAt ? null : <Link className="equipment-row__link" href={`/resources/equipment/new?equipmentId=${item.id}`}>Reserve</Link>}
								<EquipmentControls key={`${item.id}:${item.revision}`} equipment={item} />
							</li>
						))}
					</ul>
					{previous || next ? (
						<nav className="row row--between" aria-label="Pages">
							{previous ? <Link className="button button--ghost" href={previous}>Previous</Link> : <span />}
							{next ? <Link className="button button--ghost" href={next}>Next</Link> : null}
						</nav>
					) : null}
				</section>
			)}
			{/* The catalogue's own creation action (design: contextual green plus), not a generic one. */}
			<Link className="equipment-plus" href={archived ? '/resources/equipment/manage#add-equipment' : '#add-equipment'} aria-label="New equipment">
				<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
			</Link>
		</Page>
	);
}
