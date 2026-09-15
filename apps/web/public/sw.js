/* Captain's service worker: shows a push as a notification and opens the app where it points.
   It caches nothing; every page is read fresh from the server. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
	let data = { title: 'Captain', body: '', url: '/', tag: undefined };
	try { data = { ...data, ...event.data.json() }; } catch { data.body = event.data ? event.data.text() : ''; }
	event.waitUntil(self.registration.showNotification(data.title, {
		body: data.body, tag: data.tag, data: { url: data.url }, icon: '/brand/icon.png', badge: '/brand/favicon.png'
	}));
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = new URL(event.notification.data && event.notification.data.url ? event.notification.data.url : '/', self.location.origin).href;
	event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
		for (const client of windows) { if (client.url === url && 'focus' in client) return client.focus(); }
		return self.clients.openWindow(url);
	}));
});
