'use strict';
/* =========================================================
   sw.js — اختبرني / QuizMe (Service Worker)
   - تخزين مؤقت لأصول الواجهة الأساسية لتسريع الفتح والعمل دون إنترنت
   - الطلبات الخارجية (بما فيها Google AI API) تمر للشبكة دون تخزين
   - معالج notificationclick: تركيز النافذة المفتوحة وإرسال رسالة استئناف،
     أو فتح ./index.html?resume=1 إن لم توجد نافذة
   ========================================================= */

const SW_VERSION = "v2.22";
const CACHE_NAME = "quizme-" + SW_VERSION;

/* أصول الواجهة الأساسية — تُخزَّن مسبقًا عند التثبيت */
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./i18n.js",
  "./manifest.json",
  "./favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./vendor/markdown-it.min.js",
  "./vendor/markdown-it-footnote.min.js",
  "./vendor/markdown-it-task-lists.min.js",
  "./vendor/markdown-it-emoji-bare.min.js",
  "./vendor/purify.min.js",
  "./vendor/katex/katex.min.css",
  "./vendor/katex/katex.min.js",
  "./vendor/katex/auto-render.min.js",
];

/* ====== التثبيت: تخزين الأصول الأساسية مسبقًا ====== */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    /* cache: "reload" يتجاوز HTTP cache ليضمن نسخة حديثة، و allSettled كي لا يُفشل أصلٌ ناقص التثبيت */
    await Promise.allSettled(CORE_ASSETS.map((u) => cache.add(new Request(u, { cache: "reload" }))));
    await self.skipWaiting();
  })());
});

/* ====== التفعيل: حذف الكاش القديم وسيطرة فورية ====== */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ====== اعتراض الطلبات ====== */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }

  /* الطلبات الخارجية (Google AI API، الخطوط، أي مصدر آخر) تمر مباشرة دون تخزين */
  if (url.origin !== self.location.origin) return;

  /* التنقل (فتح الصفحة): شبكة أولًا لضمان آخر تحديث، وسقوط للمخزن دون اتصال */
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("./index.html", fresh.clone());
        } catch {}
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
      }
    })());
    return;
  }

  /* بقية الأصول ذاتها المنشأ: المخزن أولًا مع تحديث خلفي (stale-while-revalidate) */
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const network = fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
        return res;
      })
      .catch(() => undefined);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    const res = await network;
    if (res) return res;
    const fallback = await cache.match("./index.html");
    return fallback || Response.error();
  })());
});

/* ====== النقر على الإشعار: استئناف آخر اختبار ====== */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    let scopePath = "/";
    try { scopePath = new URL(self.registration.scope).pathname; } catch {}
    for (const client of clientList) {
      let p = "";
      try { p = new URL(client.url).pathname; } catch { continue; }
      if (p.endsWith("/index.html") || p === scopePath || p === scopePath.replace(/\/$/, "")) {
        await client.focus();
        client.postMessage({ type: "resume-quiz" });
        return;
      }
    }
    await self.clients.openWindow("./index.html?resume=1");
  })());
});
