// Service Worker Offline Cache kangge Sekat Kas Kopontren
// Versi cache sekatkas-v7 (di-bump: audit fix — guard kategori internal, paksa-logout user aktif,
// sanitasi role, prioritas toast + tombol "Coba Lagi", guard grafik, tunda banner update, dsb.)
const CACHE_NAME = 'sekatkas-v7';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-192-maskable.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './PANDUAN-SEKAT-KAS.html'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Individual catch amrih yen ana file seng ora ketemu tetep mlaku
      return Promise.all(
        ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW-SekatKas] Skip cache:', url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Network-first kanggo HTML navigation (amrih selalu seger saka server yen online)
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
          return res;
        })
        // Offline: coba cache asset yang diminta (mis. PANDUAN-SEKAT-KAS.html),
        // baru fallback ke index.html
        .catch(async () => (await caches.match(e.request)) || (await caches.match('./index.html')) || new Response('', { status: 503, statusText: 'Offline' }))
    );
    return;
  }

  // Cache-first kanggo gambar & asset statis
  e.respondWith(
    caches.match(e.request).then((res) => {
      // Aset tidak ditemukan & offline: kembalikan null (bukan HTML) agar
      // gambar/aset tampil "broken" wajar, bukan isian index.html
      return res || fetch(e.request).catch(() => null);
    })
  );
});
