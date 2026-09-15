import { Notice } from '../components/Notice.tsx';
import type { requireCurrent } from '../components/Page.tsx';
import { api, load } from '../lib/api.ts';
import { QuestionForm, type Answer, type Availability } from './QuestionForm.tsx';
export async function QuestionBox({ me }: { me: Awaited<ReturnType<typeof requireCurrent>> }) {
 const result = await load(() => api<{ answers: Answer[]; availability: Availability; timezone: string }>(`/v1/organisations/${me.organisation.organisationId}/answers?limit=4`, { token: me.token }));
 return <section className="card stack question-box" aria-labelledby="question-heading">
  <h2 id="question-heading">Ask Captain</h2>
  <p className="secondary">Ask a question about your business. Captain answers from saved data and shows its sources. Each question stands on its own.</p>
  {result.ok ? <QuestionForm key={`${me.organisation.organisationId}:${result.value.availability?.code ?? "ready"}:${result.value.answers[0]?.id ?? "empty"}`} initial={result.value.answers} availability={result.value.availability} timezone={result.value.timezone} />
   : <Notice tone="failed" action={{ href: '/', label: 'Try again' }}>Your questions could not be read. {result.error.message}</Notice>}
 </section>;
}
