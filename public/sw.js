// Generation URLs retain immutable assets; mutable documents always revalidate.
const CACHE_NAME = 'claude-ui-v9';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  if (event.request.mode === 'navigate' || url.pathname === '/version.json') {
    event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(() =>
      event.request.mode === 'navigate'
        ? new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
          headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
        })
        : Response.error()));
    return;
  }
  if (/^\/assets\/generations\/[a-f0-9]{64}\//.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME).catch(() => null);
      const cached = cache ? await cache.match(event.request).catch(() => null) : null;
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.status === 200 && response.type === 'basic' && !response.redirected) {
        if (cache) await cache.put(event.request, response.clone()).catch(() => {});
      }
      return response;
    })().catch(() => Response.error()));
    return;
  }
  event.respondWith(fetch(event.request, { cache: 'no-cache' }).catch(() => Response.error()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => /^claude-ui-v\d+$/.test(name) && name !== CACHE_NAME)
    .map(name => caches.delete(name)))).catch(() => {}).then(() => self.clients.claim()));
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  event.waitUntil((async () => {
    let payload;
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }

    // The server already sends the branded title in JSON payloads (see
    // notification-orchestrator buildPushBody). For payloads without a title
    // (e.g. plain-text pushes) resolve it from the PUBLIC branding endpoint so
    // the notification still carries the configured app name.
    let title = payload.title;
    if (!title) {
      try {
        const response = await fetch('/api/settings/branding');
        const branding = await response.json();
        if (typeof branding?.title === 'string' && branding.title) {
          title = branding.title;
        }
      } catch {
        // Offline / fetch failed — fall through to the stock default below.
      }
    }

    const options = {
      body: payload.body || '',
      icon: '/logo-256.png',
      badge: '/logo-128.png',
      data: payload.data || {},
      tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
      renotify: true
    };

    return self.registration.showNotification(title || 'CloudCLI', options);
  })());
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
