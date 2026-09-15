'use server';
import { requireCurrent } from '../components/Page.tsx';
import { api, ApiError } from '../lib/api.ts';
import type { Answer } from './QuestionForm.tsx';
export async function askQuestion(question: string): Promise<{ answer?: Answer; error?: string; code?: string }> {
 const me = await requireCurrent('/');
 if (!question.trim() || question.length > 1000) return { error: 'Enter a question of up to 1000 characters.' };
 try { return { answer: await api<Answer>(`/v1/organisations/${me.organisation.organisationId}/answers`, { token: me.token, method: 'POST', body: { question } }) }; }
 catch (error) { return { error: error instanceof ApiError ? error.message : 'The answer could not be confirmed. Reload to check your recent questions before trying again.', code: error instanceof ApiError ? error.code : 'failed' }; }
}
