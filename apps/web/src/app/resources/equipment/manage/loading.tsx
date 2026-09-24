import { Page } from '../../../../components/Page.tsx';

/** Shapes while the equipment list is read; no names are claimed before the API answers. */
export default function ManageEquipmentLoading() {
	return (
		<Page title="Manage equipment">
			<section className="card" aria-busy="true" aria-label="Reading equipment">
				<div className="skeleton" style={{ width: '45%' }} /><div className="skeleton" style={{ width: '35%' }} /><div className="skeleton" style={{ width: '40%' }} />
			</section>
		</Page>
	);
}
