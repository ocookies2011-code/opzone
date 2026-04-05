// ══════════════════════════════════════════════════════════════════════
// Zulu's Game Tracker — Service Worker v2
// GPS keepalive strategy for screen-locked devices
// ══════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'zgt-v7';
const STATIC = ['/index.html', '/'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC).catch(()=>{})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Cache-first for our own pages, network-first for API
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health')) return;
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(r => {
      if (r.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone()));
      return r;
    }))
  );
});

// ── Shared state from the main page ──────────────────────────────────
let lastGPS = null;       // { lat, lng, ts }
let roomCode = null;
let wsEndpoint = null;    // wss://... for direct WS from SW (limited support)
let playerToken = null;   // player session token

// ── Message from main page ────────────────────────────────────────────
self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'GPS_UPDATE') {
    lastGPS = { lat: msg.lat, lng: msg.lng, heading: msg.heading || 0, ts: Date.now() };
    // Relay to ALL open clients (tabs/windows) so any active tab sends it to WS
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

  // When page wakes up, send it the cached GPS so it can immediately send to server
  if (msg.type === 'PAGE_WAKE') {
    if (lastGPS && (Date.now() - lastGPS.ts) < 300000) { // within 5 mins
      e.source.postMessage({ type: 'SW_CACHED_GPS', ...lastGPS });
    }
  }
});

// ── Periodic background sync ──────────────────────────────────────────
// Android Chrome supports this — keeps SW alive to ping clients
self.addEventListener('periodicsync', e => {
  if (e.tag === 'gps-keepalive') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        if (clients.length > 0) {
          // Tell active clients to send GPS
          clients.forEach(c => c.postMessage({ type: 'SW_REQUEST_GPS' }));
        }
      })
    );
  }
});

// ── Push (if configured) can wake the SW on iOS ────────────────────
self.addEventListener('push', () => {
  // Dummy push handler — registering for push keeps SW alive on iOS 16.4+
  self.clients.matchAll({ type: 'window' }).then(clients => {
    clients.forEach(c => c.postMessage({ type: 'SW_REQUEST_GPS' }));
  });
});
