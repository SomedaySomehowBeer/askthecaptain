'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Notice } from '../components/Notice.tsx';
import { askQuestion } from './question-actions.ts';
export type Answer = { id: string; question: string; answer: string; sources: { id: string; label: string; url: string }[]; confidence: 'from_data' | 'partly' | 'not_in_data'; createdAt: string };
export type Availability = { code: string; message: string } | null;
const confidence = { from_data: 'From the saved data', partly: 'Some evidence is missing', not_in_data: 'Not in the saved data' };
function AnswerView({ answer, timezone }: { answer: Answer; timezone: string }) {
 return <article className="stack question-answer">
  <h3>{answer.question}</h3><p className="muted">{confidence[answer.confidence]} · <time dateTime={answer.createdAt}>{new Intl.DateTimeFormat('en-AU', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(answer.createdAt))}</time></p>
  <p className="question-answer__text">{answer.answer}</p>
  {answer.sources.length ? <div><h4>Sources</h4><ul>{answer.sources.map(source => <li key={source.id}><Link href={source.url}>{source.label}</Link></li>)}</ul></div> : <p className="muted">No supporting source was found.</p>}
 </article>;
}
export function QuestionForm({ initial, availability, timezone }: { initial: Answer[]; availability: Availability; timezone: string }) {
 const [answers, setAnswers] = useState(initial), [unavailable, setUnavailable] = useState(availability);
 const [question, setQuestion] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState<string>();
 async function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (pending || unavailable) return; setPending(true); setError(undefined);
  try {
   const result = await askQuestion(question);
   if (result.answer) { setAnswers(old => [result.answer!, ...old].slice(0, 4)); setQuestion(''); }
   else if (result.code && ['runtime_not_ready', 'needs_login', 'budget_spent'].includes(result.code)) setUnavailable({ code: result.code, message: result.error! });
   else setError(result.error ?? 'An answer could not be read. Try again.');
  } catch { setError('The answer could not be confirmed. Reload to check your recent questions before trying again.'); }
  finally { setPending(false); }
 }
 return <>
  {unavailable ? <Notice action={{ href: '/settings/inference', label: 'Inference settings' }}>{unavailable.message}</Notice> : null}
  <form onSubmit={submit} className="form" aria-busy={pending || undefined}>
   <div className="field"><label htmlFor="captain-question">Your question</label><input type="text" id="captain-question" name="question" value={question} onChange={e => setQuestion(e.target.value)} maxLength={1000} required disabled={pending || !!unavailable} placeholder="What tasks are overdue?" /></div>
   <button className="button button--primary" type="submit" disabled={pending || !!unavailable || !question.trim()}>{pending ? 'Reading the data…' : 'Ask Captain'}</button>
   {pending ? <p role="status">Reading your data and preparing an answer…</p> : null}
   {error ? <p role="alert" className="form__error">{error}</p> : null}
  </form>
  {answers[0] ? <AnswerView answer={answers[0]} timezone={timezone} /> : <p className="muted">No questions yet. Try a person’s full name or email, and a date such as today, this week or last month.</p>}
  {answers.length > 1 ? <details><summary>Your recent questions</summary><div className="stack">{answers.slice(1, 4).map(answer => <AnswerView key={answer.id} answer={answer} timezone={timezone} />)}</div></details> : null}
 </>;
}
