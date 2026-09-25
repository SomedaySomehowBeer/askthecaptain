import { redirect } from 'next/navigation';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** People moved out of the retired Inbox (#133). An old contact link opens the same record under
 *  People and companies; the new page checks the session and access itself. */
export default async function MovedContact({ params }: { params: Promise<{ contactId: string }> }) {
	const { contactId } = await params;
	redirect(uuid.test(contactId) ? `/settings/contacts/${contactId.toLowerCase()}` : '/settings/contacts');
}
