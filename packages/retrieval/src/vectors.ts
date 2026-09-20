import { THREAD_WEIGHT_TOKENS } from './units.ts';
/** Small vector maths for the index. Vectors are stored normalised; means are renormalised. */
export function normalise(vector: number[]): number[] {
	const norm = Math.hypot(...vector); return norm === 0 ? vector.slice() : vector.map((v) => v / norm);
}
export function weightedMean(items: { vector: number[]; weight: number }[]): number[] | null {
	const live = items.filter((item) => item.weight > 0 && item.vector.length > 0); if (live.length === 0) return null;
	const total = live.reduce((sum, item) => sum + item.weight, 0); const out = new Array<number>(live[0]!.vector.length).fill(0);
	for (const item of live) for (let i = 0; i < out.length; i++) out[i]! += (item.vector[i] ?? 0) * (item.weight / total);
	return normalise(out);
}
export const mean = (vectors: number[][]): number[] | null => weightedMean(vectors.map((vector) => ({ vector, weight: 1 })));
/** A message's weight in its thread: min(1, tokens ÷ 300), so an acknowledgement barely moves it. */
export const threadWeight = (ownTokens: number): number => Math.min(1, Math.max(ownTokens, 1) / THREAD_WEIGHT_TOKENS);
export const cosine = (a: number[], b: number[]): number => a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0) / ((Math.hypot(...a) || 1) * (Math.hypot(...b) || 1));
/** pgvector's text form; parsed back with `parseVector`. */
export const toSql = (vector: number[]): string => `[${vector.map((v) => (Number.isFinite(v) ? v : 0).toFixed(7).replace(/\.?0+$/, '') || '0').join(',')}]`;
export const parseVector = (text: string | number[] | null | undefined): number[] | null => text == null ? null : Array.isArray(text) ? text : text.replace(/^\[|\]$/g, '').split(',').map(Number);
