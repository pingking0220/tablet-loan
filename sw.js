/* 平板借還站 — 離線快取：網路優先，斷線時用快取（學校網路斷了借還站照樣能開） */
var CACHE = 'tablet-loan-v2';
var SHELL = ['./', 'index.html', 'app.js', 'common.js', 'labels.html', 'guide.html', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png',
  'vendor/html5-qrcode.min.js', 'vendor/qrcode.js', 'vendor/JsBarcode.all.min.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;  // Apps Script、字型不經過快取
  e.respondWith(fetch(req).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match('index.html'); });
  }));
});
