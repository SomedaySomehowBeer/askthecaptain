import Link from 'next/link';

/** A designed state in words: what is so, and what to do about it. Used for empty, failed and
 *  not-yet states alike, so none of them looks like an error bolted on. */
export function Notice({ title, children, tone = 'quiet', action }: { title?: string; children: React.ReactNode; tone?: 'quiet' | 'attention' | 'failed'; action?: { href: string; label: string } }) {
	return (
		<div className={`card notice notice--${tone}`} role={tone === 'failed' ? 'alert' : undefined}>
			{title ? <h3>{title}</h3> : null}
			<p className="secondary">{children}</p>
			{action ? <Link className="button button--secondary" href={action.href}>{action.label}</Link> : null}
		</div>
	);
}
