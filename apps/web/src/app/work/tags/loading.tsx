import { Page } from '../../../components/Page.tsx';

/** Shapes while the tags are read; no names are claimed before the API answers. */
export default function TagsLoading() {
	return (
		<Page title="Tags">
			<section className="card" aria-busy="true" aria-label="Reading tags">
				<div className="skeleton" style={{ width: '45%' }} /><div className="skeleton" style={{ width: '30%' }} /><div className="skeleton" style={{ width: '38%' }} />
			</section>
		</Page>
	);
}
