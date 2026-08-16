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
var CACHE_VERSION = 'sol-cache-v2';
var CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-512-maskable.png'
];
var OPTIONAL_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/128/three.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js',
  'https://unpkg.com/three@0.128.0/build/three.min.js'
];

self.addEventListener('install', function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function(cache){
      // core assets: cache individually too, so one bad entry can't take
      // the rest down the way a single cache.addAll() would.
      var corePromises = CORE_ASSETS.map(function(url){
        return cache.add(url).catch(function(){ /* ignore individual failures */ });
      });
      // optional (three.js mirrors): best-effort, never blocks install
      var optionalPromises = OPTIONAL_ASSETS.map(function(url){
        return cache.add(url).catch(function(){ /* offline or blocked — fine, runtime fetch will retry later */ });
      });
      return Promise.all(corePromises.concat(optionalPromises));
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
