import Link from 'next/link';
export function WorkSwitch({ selected }: { selected: 'tasks' | 'projects' }) {
 return <nav className="work-switch" aria-label="Work type"><Link href="/work" aria-current={selected === 'tasks' ? 'page' : undefined}>Tasks</Link><Link href="/work/projects" aria-current={selected === 'projects' ? 'page' : undefined}>Projects</Link></nav>;
}
