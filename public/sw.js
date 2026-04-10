// ══════════════════════════════════════════════════════════════════════
// Zulu's Game Tracker — Service Worker v3
// Strategy: network-first for HTML (always get latest), cache for assets
// GPS keepalive strategy for screen-locked devices
// ══════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'zgt-v10';
// Only cache truly static assets — NOT index.html (it changes on every deploy)
const PRECACHE = ['/sw.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE).catch(()=>{})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Never intercept API or health calls
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health')) return;
  // Never intercept cross-origin
  if (url.origin !== location.origin) return;

  // HTML pages — always network first, fall back to cache only if offline
  if (url.pathname === '/' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request).then(r => {
        // Cache the fresh response for offline fallback
        if (r.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone()));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Everything else (leaflet, fonts, etc.) — cache first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(r => {
      if (r.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone()));
      return r;
    }))
  );
});

// ── Shared state from the main page ──────────────────────────────────
let lastGPS = null;
let roomCode = null;
let wsEndpoint = null;
let playerToken = null;

self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'GPS_UPDATE') {
    lastGPS = { lat: msg.lat, lng: msg.lng, heading: msg.heading || 0, ts: Date.now() };
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
      clients.forEach(c => c.postMessage({ type: 'SW_RELAY_GPS', ...lastGPS }));
    });
  }

  if (msg.type === 'PLAYER_CONTEXT') {
    roomCode = msg.roomCode;
    wsEndpoint = msg.wsEndpoint;
    playerToken = msg.playerToken;
    lastGPS = msg.lastGPS || lastGPS;
  }

  if (msg.type === 'PAGE_WAKE') {
    if (lastGPS && (Date.now() - lastGPS.ts) < 300000) {
      e.source.postMessage({ type: 'SW_CACHED_GPS', ...lastGPS });
    }
  }
});

self.addEventListener('periodicsync', e => {
  if (e.tag === 'gps-keepalive') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SW_REQUEST_GPS' }));
      })
    );
  }
});

self.addEventListener('push', () => {
  self.clients.matchAll({ type: 'window' }).then(clients => {
    clients.forEach(c => c.postMessage({ type: 'SW_REQUEST_GPS' }));
  });
});
