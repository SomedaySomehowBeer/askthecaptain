'use client';
import { useActionState, version } from 'react';
import { save } from './actions.ts';
export function ReproForm({ refresh }: { refresh: boolean }) {
 const [count, action, pending] = useActionState(save.bind(null, refresh), 0);
 return <form action={action} id="probe"><p>Browser React: {version}</p><output data-count={count}>{count} saves settled</output><button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save probe'}</button></form>;
}
