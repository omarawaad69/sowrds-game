/*
  Service worker: network-first.
  - Every load tries the network FIRST so any update you push to
    GitHub -> Cloudflare Pages shows up immediately, automatically,
    with no need to uninstall/reinstall the APK.
  - If the device is offline, it falls back to the last successful
    copy so the game still opens.
  - CACHE_VERSION only needs bumping if you want to force-clear old
    offline copies; it is NOT required for updates to reach players.
*/
var CACHE_VERSION = 'sol-cache-v1';
var CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-512-maskable.png'
];

self.addEventListener('install', function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function(cache){
      return cache.addAll(CORE_ASSETS).catch(function(){ /* ignore individual failures */ });
    })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_VERSION; })
            .map(function(k){ return caches.delete(k); })
      );
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  if(event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request).then(function(networkResponse){
      var copy = networkResponse.clone();
      caches.open(CACHE_VERSION).then(function(cache){ cache.put(event.request, copy); });
      return networkResponse;
    }).catch(function(){
      return caches.match(event.request).then(function(cached){
        return cached || caches.match('/index.html');
      });
    })
  );
});
