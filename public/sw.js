// Keeps the app usable without a connection once it has been opened.
// Pages load from the network first (so updates arrive), everything else from the cache first.
const CACHE = "build-steps-v6";
const CORE = ["./", "./index.html", "./manifest.webmanifest", "./library/kits.json", "./library/xplorer/parts.json",
  "./slides/bg1.jpg", "./slides/bg2.jpg", "./slides/bg3.jpg", "./slides/flip.svg", "./slides/turn.svg", "./icon-192.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;
  const store = response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(request, copy)); }
    return response;
  };
  if (request.mode === "navigate" || request.url.endsWith(".json")) {
    event.respondWith(fetch(request).then(store).catch(() => caches.match(request).then(hit => hit || caches.match("./index.html"))));
  } else {
    event.respondWith(caches.match(request).then(hit => hit || fetch(request).then(store)));
  }
});
