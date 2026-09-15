import type { Metadata, Viewport } from 'next';
import { ThemeScript } from '../components/ThemeScript.tsx';
import './globals.css';

export const metadata: Metadata = {
	title: { default: 'Ask The Captain', template: '%s · Ask The Captain' },
	description: 'An administrative assistant for small businesses.',
	manifest: '/manifest.webmanifest',
	appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Captain' },
	icons: { icon: [{ url: '/brand/favicon.png', type: 'image/png' }, { url: '/brand/captain.svg', type: 'image/svg+xml' }], apple: '/brand/icon.png' }
};
export const viewport: Viewport = { viewportFit: 'cover', themeColor: [{ media: '(prefers-color-scheme: dark)', color: '#142619' }, { media: '(prefers-color-scheme: light)', color: '#f3ecdf' }] };

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en-AU" suppressHydrationWarning>
			<head>
				<ThemeScript />
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
				<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,300..900,0..100,0..1;1,9..144,300..900,0..100,0..1&family=Inter:wght@400;500;600;700;800&display=swap" />
			</head>
			<body>{children}</body>
		</html>
	);
}
