import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Captain } from '../../components/Captain.tsx';
import { current } from '../../lib/session.ts';
import { WelcomeForm } from './WelcomeForm.tsx';

export const metadata: Metadata = { title: 'Welcome' };

export default async function WelcomePage() {
	const me = await current();
	if (!me) redirect('/sign-in?return_to=/welcome');
	if (me.organisation) redirect('/');
	return (
		<main className="page page--narrow">
			<header className="stack">
				<Captain size={48} />
				<h1>Welcome aboard, {me.me.user.name.split(' ')[0] || me.me.user.email}.</h1>
				<p>Name the business Captain will help you run. You will be its owner; you can invite the rest of the crew from Settings.</p>
			</header>
			<WelcomeForm />
		</main>
	);
}
