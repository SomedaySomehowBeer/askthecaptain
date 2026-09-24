import Link from 'next/link';

type View = { label: string; detail: string; href?: string };
export function ViewGroup({ title, views }: { title: string; views: View[] }) {
	return <section className="view-group" aria-label={title}>
		<h2>{title}</h2><ul className="bare view-group__rows">{views.map(view => <li key={view.label}>
			{view.href ? <Link className="view-row" href={view.href}><span><strong>{view.label}</strong><small>{view.detail}</small></span><span aria-hidden="true">›</span></Link>
				: <div className="view-row view-row--disabled" aria-disabled="true"><span><strong>{view.label}</strong><small>{view.detail}</small></span><span className="chip">Not available yet</span></div>}
		</li>)}</ul>
	</section>;
}
