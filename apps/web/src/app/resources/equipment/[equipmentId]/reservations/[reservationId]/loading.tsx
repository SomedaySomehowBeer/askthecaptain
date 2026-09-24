import { Page } from '../../../../../../components/Page.tsx';

/** Shapes while the reservation is read; no status or time is claimed yet. */
export default function ReservationLoading() {
	return (
		<Page title="Reservation">
			<section className="card" aria-busy="true" aria-label="Reading the reservation">
				<div className="skeleton" style={{ width: '30%' }} /><div className="skeleton" style={{ width: '70%' }} /><div className="skeleton" style={{ width: '55%' }} />
			</section>
		</Page>
	);
}
