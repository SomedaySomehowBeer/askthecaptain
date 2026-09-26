import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { Notice } from '../../../../components/Notice.tsx';
import { AccessLost } from '../../../../components/chat/AccessLost.tsx';
import { chatViewer } from '../../../../components/chat/viewer.ts';
import { getConversation, readMembers } from '../../actions.ts';
import { isUuid } from '../../types.ts';
import { DetailsForms } from './DetailsForms.tsx';
import '../../../../components/chat/chat.css';

export const metadata = { title: 'Conversation details' };

/** A conversation's title, people and links (plan §1 "Details"). Every change carries the revision it was based on. */
export default async function DetailsPage({ params }: { params: Promise<{ conversationId: string }> }) {
	const { conversationId: raw } = await params;
	const me = await requireCurrent(`/chat/${raw}/details`);
	const viewer = await chatViewer(me);
	const conversationId = raw.toLowerCase();
	if (!isUuid(raw)) return <Page title="Conversation details" parent={{ href: '/chat', label: 'Chat' }}><AccessLost scope={viewer.scope} conversationId={conversationId} /></Page>;
	const [detail, members] = await Promise.all([getConversation(viewer.scope, conversationId), readMembers(viewer.scope)]);
	if (!detail.ok && detail.kind === 'gone') return <Page title="Conversation details" parent={{ href: '/chat', label: 'Chat' }}><AccessLost scope={viewer.scope} conversationId={conversationId} /></Page>;
	if (!detail.ok) return <Page title="Conversation details" parent={{ href: `/chat/${conversationId}`, label: 'Conversation' }}>
		<Notice title="Details could not be read" tone="failed" action={{ href: `/chat/${conversationId}/details`, label: 'Try again' }}>
			{detail.kind === 'rate-limited' ? `Too many requests just now. Try again in ${detail.retryAfter} seconds.` : detail.error}
		</Notice>
	</Page>;
	return <Page title="Details" eyebrow={`# ${detail.value.title}`} parent={{ href: `/chat/${conversationId}`, label: detail.value.title }}>
		<DetailsForms viewer={viewer} detail={detail.value} members={members.ok ? members.value : null} />
	</Page>;
}
