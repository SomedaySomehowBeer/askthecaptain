import { Page } from '../../components/Page.tsx';

/** Shown while Chat is read. Shapes, not numbers: nothing here claims to know what is unread. */
export default function ChatLoading() {
	return (
		<Page title="Chat">
			<section className="card" aria-busy="true" aria-label="Reading Chat">
				<div className="skeleton" style={{ width: '40%' }} />
			</section>
			<section className="card" aria-hidden="true">
				<div className="skeleton" style={{ width: '70%' }} /><div className="skeleton" style={{ width: '50%' }} />
				<div className="skeleton" style={{ width: '65%' }} /><div className="skeleton" style={{ width: '45%' }} />
			</section>
		</Page>
	);
}
