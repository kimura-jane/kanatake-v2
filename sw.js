const CACHE_NAME = "kanatake-v2-cache-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  // 外部API・外部アセットはキャッシュしない
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return res;
      });
    }).catch(() => caches.match("/index.html"))
  );
});

// プッシュ通知受信
self.addEventListener("push", event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "おにぎり屋かなたけ";
  const options = {
    body: data.body || "新しいお知らせがあります",
    icon: "https://kimura-jane.github.io/kanatae-app/onigiriya_kanatake_192.png",
    badge: "https://kimura-jane.github.io/kanatae-app/onigiriya_kanatake_192.png",
    data: { url: data.url || "/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(clients.openWindow(url));
});
