// sw.js
// Minimal service worker — required by Android/Chrome for the form to be
// "installable" as an app. It does NOT cache anything: every request still
// goes straight to the network, so products/prices/stock stay always live.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
