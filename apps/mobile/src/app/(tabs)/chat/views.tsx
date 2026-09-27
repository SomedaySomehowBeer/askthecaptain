import { Screen } from '../../../components/Screen.tsx';
import { ViewList } from '../../../components/ViewList.tsx';

export default function ChatViews() {
	return <Screen section="chat" onViewList><ViewList section="chat" /></Screen>;
}
