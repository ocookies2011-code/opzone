// ══════════════════════════════════════════════════════════════════════
// Swindon Airsoft Tactical — Service Worker
// Keeps GPS tracking alive when phone screen is locked
// ══════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'sa-tactical-v5';
const ASSETS = ['/', '/index.html', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];

// ── Install: cache static assets ─────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: serve from cache when offline ─────────────────────────────
self.addEventListener('fetch', e => {
  // Only cache GET requests for same origin
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Background Sync: GPS location messages ────────────────────────────
// The main page sends GPS coordinates here via postMessage when it
// detects visibilitychange. The SW relays them to the server.
// This keeps location updates flowing when the screen is locked on iOS/Android.

let wsUrl = null;
let pendingLocations = [];

self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg) return;

  switch (msg.type) {
    case 'SET_WS_URL':
      wsUrl = msg.url;
      break;

    case 'GPS_UPDATE':
      // Store latest position — client will send it when it reconnects
      pendingLocations = [{ lat: msg.lat, lng: msg.lng, heading: msg.heading, ts: Date.now() }];
      // Broadcast to all clients so any open tab gets it
      self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SW_GPS', lat: msg.lat, lng: msg.lng, heading: msg.heading }));
      });
      break;

    case 'GET_PENDING':
      e.source.postMessage({ type: 'PENDING_GPS', locations: pendingLocations });
      pendingLocations = [];
      break;
  }
});

// ── Periodic background sync (where supported) ────────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'gps-keepalive') {
    e.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SW_PING_GPS' }));
      })
    );
  }
});
