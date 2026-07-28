// Service Worker for CloudCLI PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
const CACHE_NAME = 'claude-ui-v6';
const urlsToCache = [
  '/manifest.json'
];

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Fetch event — network-first for everything except hashed assets
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept cross-origin requests (e.g. cloudflareinsights beacon, CDNs).
  // Passing them through prevents TypeError when the response can't be cloned or
  // cached, and stops console errors from third-party fetches.
  if (!url.startsWith(self.location.origin)) {
    return;
  }

  // Never intercept API requests or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/manifest.json').then(() =>
        new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
          headers: { 'Content-Type': 'text/html' }
        })
      ))
    );
    return;
  }

  // Hashed assets (JS/CSS in /assets/) — cache-first since filenames change per build
  if (url.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          // Only persist a healthy same-origin asset. A 502 served during the
          // restart drain window — or any 4xx/5xx / opaque / redirect response —
          // must never be cached, otherwise the broken body would be served
          // forever under the immutable hashed URL until a hard refresh.
          if (response.ok && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => Response.error());
      })
    );
    return;
  }

  // Everything else — network-first with safe cache fallback.
  // caches.match() resolves to undefined when there is no cached entry;
  // wrapping with || Response.error() ensures respondWith always receives a
  // valid Response and never throws TypeError.
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then(cached => cached || Response.error())
    )
  );
});

// Activate event — purge old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    )
  );
  self.clients.claim();
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
