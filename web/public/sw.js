// Minimal app-shell cache - offline support is "best effort" here, not a
// hard requirement (this app is fundamentally live data from Google). Bump
// CACHE_NAME on any shell change to force everyone onto the new version.
// Deliberately never touches googleapis.com or /api/token-exchange - those
// carry live, auth-bearing personal data and must always hit the network.
var CACHE_NAME = "nexus-shell-v1";
var SHELL_FILES = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/js/auth.js",
  "/js/calendarApi.js",
  "/js/gmailApi.js",
  "/js/settingsPanel.js",
  "/js/app.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png"
];

self.addEventListener("install", function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){ return cache.addAll(SHELL_FILES); })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function(event){
  event.waitUntil(
    caches.keys().then(function(names){
      return Promise.all(names.filter(function(n){ return n !== CACHE_NAME; }).map(function(n){ return caches.delete(n); }));
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function(event){
  var url = new URL(event.request.url);
  if(url.origin !== location.origin) return; // never intervene on cross-origin (Google APIs etc.)
  if(url.pathname.indexOf("/api/") === 0) return; // token-exchange - always live

  event.respondWith(
    caches.match(event.request).then(function(cached){
      return cached || fetch(event.request);
    })
  );
});
