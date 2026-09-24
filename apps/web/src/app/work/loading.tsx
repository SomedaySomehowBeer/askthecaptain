import { Page } from '../../components/Page.tsx';
import './work.css';

/** Shown while the list is read. Shapes, not numbers: nothing here claims to know what is due. */
export default function WorkLoading() {
	return (
		<Page title="Work">
			<section className="card" aria-busy="true" aria-label="Reading your work">
				<div className="skeleton" style={{ width: '35%' }} />
			</section>
			<section className="card" aria-hidden="true">
				<div className="skeleton" style={{ width: '70%' }} /><div className="skeleton" style={{ width: '45%' }} />
				<div className="skeleton" style={{ width: '60%' }} /><div className="skeleton" style={{ width: '40%' }} />
			</section>
		</Page>
	);
}
