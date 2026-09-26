import { Page, requireCurrent } from '../../../components/Page.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { AccessLost } from '../../../components/chat/AccessLost.tsx';
import { chatViewer } from '../../../components/chat/viewer.ts';
import { getConversation, readMessages, readPins } from '../actions.ts';
import { chatLimits } from '../types.ts';
import { Thread } from './Thread.tsx';
import '../../../components/chat/chat.css';

export const metadata = { title: 'Conversation' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One conversation (plan §1): its header, pins and latest messages read in parallel, then the live thread. An
 *  unknown, foreign or inaccessible id is the same "not available" state as losing access later. */
export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
	const { conversationId: raw } = await params;
	const me = await requireCurrent(`/chat/${raw}`);
	const parent = { href: '/chat', label: 'Chat' };
	const viewer = await chatViewer(me);
	if (!uuid.test(raw)) return <Page title="Conversation" parent={parent}><AccessLost scope={viewer.scope} conversationId={raw.toLowerCase()} /></Page>;
	const conversationId = raw.toLowerCase();
	const [detail, messages, pins] = await Promise.all([
		getConversation(viewer.scope, conversationId),
		readMessages(viewer.scope, conversationId, { latest: chatLimits.threadPage }),
		readPins(viewer.scope, conversationId),
	]);
	const failures = [detail, messages, pins].filter(read => !read.ok);
	if (failures.some(read => !read.ok && read.kind === 'gone')) return <Page title="Conversation" parent={parent}><AccessLost scope={viewer.scope} conversationId={conversationId} /></Page>;
	if (failures.some(read => !read.ok && read.kind === 'signed-out')) return <Page title="Conversation" parent={parent}>
		<Notice title="Your session has ended" tone="attention" action={{ href: `/sign-in?return_to=${encodeURIComponent(`/chat/${conversationId}`)}`, label: 'Sign in again' }}>
			Sign in again to read this conversation. Anything you had not sent from this tab is kept.</Notice>
	</Page>;
	if (!detail.ok || !messages.ok || !pins.ok) {
		const failure = failures[0]!;
		const reason = failure.ok ? '' : failure.kind === 'rate-limited' ? `Too many requests just now. Try again in ${failure.retryAfter} seconds.`
			: failure.kind === 'wrong-scope' ? 'This page was opened for a different sign-in or organisation. Reload to continue in the current one.'
			: `This conversation could not be read just now.${failure.error ? ` ${failure.error}` : ''}${'requestId' in failure && failure.requestId ? ` Reference ${failure.requestId}.` : ''}`;
		return <Page title="Conversation" parent={parent}>
			<Notice title="Conversation could not be read" tone="failed" action={{ href: `/chat/${conversationId}`, label: 'Try again' }}>{reason}</Notice>
		</Page>;
	}
	return <Page title={detail.value.title} parent={parent} hideTitle>
		<Thread key={conversationId} viewer={viewer} detail={detail.value} messages={messages.value} pins={pins.value} />
	</Page>;
}
