/* オフラインで起動できるようにアプリ本体だけをキャッシュする。
   写真データは IndexedDB にあり、ここには入らない。 */
const CACHE = 'dental-photo-v15';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);
  // Google の API と認証は常にネットワークへ
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('google.com')) return;
  if (ev.request.method !== 'GET') return;

  ev.respondWith(
    caches.match(ev.request).then(hit => hit || fetch(ev.request).then(res => {
      if (res.ok && url.origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(ev.request, copy));
      }
      return res;
    }).catch(() => hit))
  );
});
