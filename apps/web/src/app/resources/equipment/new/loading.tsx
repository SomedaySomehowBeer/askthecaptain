import { Page } from '../../../../components/Page.tsx';

/** Shapes while the equipment and choices are read; no time or booking is claimed yet. */
export default function NewReservationLoading() {
	return (
		<Page title="Reserve equipment">
			<section className="card" aria-busy="true" aria-label="Reading the equipment">
				<div className="skeleton" style={{ width: '40%' }} /><div className="skeleton" style={{ width: '65%' }} /><div className="skeleton" style={{ width: '50%' }} />
			</section>
		</Page>
	);
}
