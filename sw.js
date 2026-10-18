/* Service Worker: оболочка приложения работает без интернета.
   Данные погоды приложение кэширует само (localStorage) — API запросы SW не трогает.
   ВАЖНО: при любом изменении файлов приложения увеличьте VERSION в config.js — так пользователи получат обновление. */
// Номер версии берём из config.js (одно место для страницы и Service Worker)
try { importScripts("config.js"); } catch (e) { /* без config.js работаем с версией по умолчанию */ }
const VERSION = "wx-v" + ((self.WX_CONFIG && self.WX_CONFIG.VERSION) || "0.0.0");
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "config.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  // skipWaiting не вызываем сами: новая версия ждёт, пока пользователь нажмёт «Обновить».
  // cache:"reload" обязателен: иначе файлы берутся из HTTP-кэша браузера (GitHub Pages кэширует их на 10 минут)
  // и «новая версия» устанавливается со СТАРЫМ app.js.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", e => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Open-Meteo и др. — напрямую в сеть

  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      if (req.mode === "navigate") return (await caches.match("index.html")) || Response.error();
      return Response.error();
    }
  })());
});
