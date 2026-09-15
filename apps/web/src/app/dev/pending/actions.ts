'use server';
import { revalidatePath } from 'next/cache';
import { requireLocalRepro } from './guard.ts';
export async function save(refresh: boolean, previous: number, _form: FormData) {
 requireLocalRepro();
 await new Promise(resolve => setTimeout(resolve, 10));
 if (refresh) revalidatePath('/dev/pending');
 return previous + 1;
}
export async function plain(_index: number, refresh: boolean, _form: FormData) {
 requireLocalRepro();
 if (refresh) revalidatePath('/dev/pending');
}
