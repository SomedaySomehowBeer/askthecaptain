import { Page } from '../../../../../components/Page.tsx';

/** Shapes while the task and its tags are read; the task's name waits for the API. */
export default function TaskTagsLoading() {
	return (
		<Page title="Task tags">
			<section className="card" aria-busy="true" aria-label="Reading the task's tags">
				<div className="skeleton" style={{ width: '50%' }} /><div className="skeleton" style={{ width: '35%' }} /><div className="skeleton" style={{ width: '42%' }} />
			</section>
		</Page>
	);
}
