// Service Worker for Personal Lending — Collection Tracker
const CACHE_VERSION = 'v2';
const STATIC_CACHE = `lendtrack-static-${CACHE_VERSION}`;
const DATA_CACHE = `lendtrack-data-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  '/',
  '/app.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Offline write queue
const QUEUE_KEY = 'offline-queue';

async function getQueue() {
  const cache = await caches.open('lendtrack-queue');
  const resp = await cache.match(QUEUE_KEY);
  if (!resp) return [];
  return resp.json();
}

async function saveQueue(queue) {
  const cache = await caches.open('lendtrack-queue');
  await cache.put(QUEUE_KEY, new Response(JSON.stringify(queue)));
}

async function addToQueue(request) {
  const queue = await getQueue();
  const body = await request.clone().text();
  queue.push({ url: request.url, method: request.method, body, timestamp: Date.now() });
  await saveQueue(queue);
}

async function flushQueue() {
  const queue = await getQueue();
  if (queue.length === 0) return;
  const remaining = [];
  for (const item of queue) {
    try {
      await fetch(item.url, { method: item.method, body: item.body, headers: { 'Content-Type': 'application/json' } });
    } catch {
      remaining.push(item);
    }
  }
  await saveQueue(remaining);
}

// Fetch strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('/app.html')))
    );
    return;
  }

  // API calls: network-first, queue writes if offline
  if (url.pathname.startsWith('/api/')) {
    if (request.method !== 'GET') {
      event.respondWith(
        fetch(request.clone()).catch(async () => {
          await addToQueue(request);
          return new Response(JSON.stringify({ queued: true, offline: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        })
      );
      return;
    }

    // GET API: network-first, fallback to cache
    event.respondWith(
      fetch(request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(DATA_CACHE).then((cache) => cache.put(request, clone));
          return resp;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, clone));
        }
        return resp;
      });
    })
  );
});

// Sync queued writes when back online
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-payments') {
    event.waitUntil(flushQueue());
  }
});

// Message handler
self.addEventListener('message', (event) => {
  if (event.data === 'flush-queue') {
    flushQueue().then(() => {
      event.ports[0]?.postMessage({ done: true });
    });
  }
});
