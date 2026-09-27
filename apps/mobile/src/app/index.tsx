import { Redirect } from 'expo-router';

/** Captain opens at Work → My work (plan D11). */
export default function Home() {
	return <Redirect href="/work" />;
}
