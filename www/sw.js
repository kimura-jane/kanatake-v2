
/*
 * おにぎり屋かなたけ
 * ブラウザ版キャッシュ管理 v3
 *
 * テーマ：おにぎりでえがお
 * 既存のプッシュ通知処理は維持します。
 */

const CACHE_NAME = 'kanatake-v2-cache-v3';
const CACHE_PREFIX = 'kanatake-v2-cache-';

function getBasePath() {
  const pathname = new URL(self.registration.scope).pathname;
  return pathname.endsWith('/') ? pathname : pathname + '/';
}

function isCoreAsset(pathname, base) {
  const core = new Set([
    base,
    base + 'index.html',
    base + 'style.css',
    base + 'kanatake-theme.css',
    base + 'app.js',
    base + 'manifest.json',
    base + 'sales-board.js',
    base + 'sales-board.css',
    base + 'sales-config.js',
    base + 'sw.js'
  ]);
  return core.has(pathname);
}

function isStaticImage(pathname) {
  return /\.(png|jpg|jpeg|webp|svg|ico)$/i.test(pathname);
}

async function cachePutSafe(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch {
    // キャッシュ保存に失敗しても通信結果を優先する。
  }
}

self.addEventListener('install', event => {
  const base = getBasePath();
  const assets = [
    base,
    base + 'index.html',
    base + 'style.css',
    base + 'kanatake-theme.css?v=3',
    base + 'app.js',
    base + 'manifest.json',
    base + 'sales-board.js',
    base + 'sales-board.css',
    base + 'sales-config.js'
  ];

  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    await Promise.allSettled(assets.map(async url => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (response.ok) {
          await cachePutSafe(cache, url, response);
        }
      } catch {
        // 一部のファイルが取得できなくてもインストールを妨げない。
      }
    }));

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter(name =>
          name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME
        )
        .map(name => caches.delete(name))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const base = getBasePath();

  // 外部API・外部画像・POSTは対象外。
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(base)
  ) {
    return;
  }

  const isNavigation = request.mode === 'navigate';
  const isCore = isCoreAsset(url.pathname, base);

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // ページと重要なCSS・JSはネットワーク優先。
    if (isNavigation || isCore) {
      try {
        const fresh = await fetch(request, { cache: 'no-store' });
        if (fresh.ok) {
          await cachePutSafe(cache, request, fresh.clone());
        }
        return fresh;
      } catch {
        const saved = await caches.match(request);
        if (saved) return saved;

        if (isNavigation) {
          const fallback = await caches.match(base + 'index.html');
          if (fallback) return fallback;
        }

        throw new Error('Offline: no cached response');
      }
    }

    // 商品画像などはキャッシュ優先。
    if (isStaticImage(url.pathname)) {
      const saved = await caches.match(request);
      if (saved) return saved;

      const fresh = await fetch(request);
      if (fresh.ok) {
        await cachePutSafe(cache, request, fresh.clone());
      }
      return fresh;
    }

    // その他の同一オリジンの通信はネットワーク優先。
    try {
      const fresh = await fetch(request);
      if (fresh.ok) {
        await cachePutSafe(cache, request, fresh.clone());
      }
      return fresh;
    } catch {
      const saved = await caches.match(request);
      if (saved) return saved;
      throw new Error('Offline: no cached response');
    }
  })());
});

// プッシュ通知受信（従来の動作を維持）
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'おにぎり屋かなたけ';
  const options = {
    body: data.body || '新しいお知らせがあります',
    icon: 'https://kimura-jane.github.io/kanatae-app/onigiriya_kanatake_192.png',
    badge: 'https://kimura-jane.github.io/kanatae-app/onigiriya_kanatake_192.png',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
