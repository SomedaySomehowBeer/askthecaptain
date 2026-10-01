/* Notification-only worker. No fetch handler, page cache, message bodies in storage or background reads. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
function appPath(value) {
 try {
  const url = new URL(typeof value === 'string' ? value : '/', self.location.origin);
  if (url.origin !== self.location.origin || url.username || url.password || /^(\/auth\/|\/v1\/|\/connections\/|\/webhooks\/)/.test(url.pathname)) return '/';
  return url.pathname + url.search + url.hash;
 } catch { return '/'; }
}
self.addEventListener('push', event => {
 let input; try { input = event.data.json(); } catch { input = null; }
 const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
 const text = (value, fallback, limit) => typeof value === 'string' ? value.slice(0, limit) : fallback;
 event.waitUntil(self.registration.showNotification(text(data.title, 'Captain', 120), {
  body: text(data.body, '', 500), tag: text(data.tag, '', 120), data: { url: appPath(data.url) }
 }));
});
self.addEventListener('notificationclick', event => {
 event.notification.close();
 const url = new URL(appPath(event.notification.data?.url), self.location.origin).href;
 event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
  const existing = windows.find(client => client.url === url && typeof client.focus === 'function');
  return existing ? existing.focus() : self.clients.openWindow(url);
 }));
});
