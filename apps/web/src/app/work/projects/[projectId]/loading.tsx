import { Page } from '../../../../components/Page.tsx';
export default function ProjectLoading() {
 return <Page title="Project" parent={{ href: '/work/projects', label: 'Projects' }}>
  <section className="card" aria-busy="true" aria-label="Reading project"><div className="skeleton" style={{ width: '60%' }}/><div className="skeleton" style={{ width: '35%' }}/></section>
  <section className="card" aria-hidden="true"><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/></section>
 </Page>;
}
