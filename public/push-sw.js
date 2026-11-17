// FaixaSegura RFC 8291 Web Push Service Worker Listener
self.addEventListener('push', (event) => {
  let payload = {
    title: 'FaixaSegura SGIFR',
    body: 'Novo alerta preventivo nos seus terrenos registados.',
    url: '/?autostart=1',
    tag: 'faixasegura-hazard',
  };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        payload = { ...payload, ...parsed };
      }
    }
  } catch {
    // Fallback to plain text if non-JSON push payload
    try {
      payload.body = event.data ? event.data.text() : payload.body;
    } catch {
      // Keep default message
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      tag: payload.tag,
      data: { url: payload.url || '/?autostart=1' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/?autostart=1';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
