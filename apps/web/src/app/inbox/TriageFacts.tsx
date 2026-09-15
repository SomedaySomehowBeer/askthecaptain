import type { Triage } from './mail.ts';
export function TriageFacts({ triage }: { triage: Triage }) {
 return <div className="stack"><span className="chip">{triage.category}</span><p>{triage.summary}</p>
  <dl>{Object.entries(triage.facts).filter(([, value]) => Array.isArray(value) ? value.length : value).map(([key, value]) => <div key={key}><dt>{key[0]!.toUpperCase() + key.slice(1)}</dt><dd>{Array.isArray(value) ? value.join(' · ') : value}</dd></div>)}</dl>
 </div>;
}
