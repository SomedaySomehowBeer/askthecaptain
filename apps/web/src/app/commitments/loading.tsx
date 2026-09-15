import { Page } from '../../components/Page.tsx';

/** Shown while the list is read. Shapes, not numbers: nothing here claims to know what is due. */
export default function CommitmentsLoading() {
	return (
		<Page title="Commitments">
			<section className="card" aria-busy="true" aria-label="Reading the list">
				<div className="skeleton" style={{ width: '40%' }} /><div className="skeleton" style={{ width: '70%' }} /><div className="skeleton" style={{ width: '55%' }} />
			</section>
			<section className="card" aria-hidden="true"><div className="skeleton" style={{ width: '30%' }} /><div className="skeleton" style={{ width: '60%' }} /></section>
		</Page>
	);
}
