'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setTaskTag } from './actions.ts';

/** Add or Remove one tag. The row shows the API's answer after the page is re-read; nothing flips
 *  before that, and an unconfirmed outcome says to refresh. */
export function TagToggle({ taskId, tagId, name, attached }: { taskId: string; tagId: string; name: string; attached: boolean }) {
	const router = useRouter();
	const [pending, start] = useTransition();
	const [error, setError] = useState<string | null>(null);
	function change() {
		if (pending) return;
		const data = new FormData();
		data.set('taskId', taskId); data.set('tagId', tagId); data.set('attach', attached ? 'false' : 'true');
		setError(null);
		start(async () => {
			try {
				const result = await setTaskTag(data);
				if ('error' in result) setError(result.error);
				else router.refresh();
			} catch { setError('Captain could not confirm the change. Refresh the page to check before trying again.'); }
		});
	}
	return (
		<>
			<button type="button" className={`button button--small ${attached ? 'button--ghost' : 'button--secondary'}`} onClick={change} disabled={pending} aria-busy={pending || undefined}
				aria-label={`${attached ? 'Remove' : 'Add'} ${name}`}>
				{pending ? (attached ? 'Removing…' : 'Adding…') : attached ? 'Remove' : 'Add'}
			</button>
			{error ? <p className="form__error work-tag-choice__error" role="alert">{error}</p> : null}
		</>
	);
}
