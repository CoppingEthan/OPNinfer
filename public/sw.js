/*
 * OPNinfer service worker.
 *
 * IT CACHES NOTHING, ON PURPOSE. Read this before adding a cache.
 *
 * Two reasons. First, every page here is behind auth and rendered per request
 * (the root layout is force-dynamic); a cached HTML document is one person's
 * chat sitting in another person's browser on a shared phone, and a service
 * worker outlives the session that created it. Second, the app is a client for
 * a server it cannot work without — there is no offline chat to serve, so a
 * cached shell would only ever be a stale version of a screen that needs the
 * network anyway. Static assets are already immutable-and-hashed under
 * /_next/static and handled perfectly well by the HTTP cache.
 *
 * So the whole job is: when a NAVIGATION fails because the device is offline,
 * show a page that says so instead of the browser's dinosaur. That also
 * satisfies the one thing Chrome wants before it will offer "Install" — a
 * service worker with a fetch handler.
 *
 * Everything else is passed straight through by simply not calling
 * respondWith(): the API (auth, SSE streams, uploads, downloads), cross-origin
 * requests, non-GET, and Next's own client-side navigation fetches, which are
 * not navigations and must never be answered with an HTML page.
 *
 * TO REMOVE IT FROM DEVICES ALREADY CARRYING IT, replace the body of this file
 * with `self.registration.unregister()` inside an activate handler and deploy;
 * an installed worker is not undone by deleting the file (the browser keeps
 * the last copy it fetched).
 */

const VERSION = "1";

self.addEventListener("install", () => {
  // Nothing to precache. Take over from any previous worker immediately —
  // safe precisely because no cached content can be stale.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Older versions of this worker never wrote a cache either, but if one
      // ever does, this is what stops it outliving its deploy.
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never the API. It carries the chat stream (SSE, held open for a whole
  // reply), uploads, signed downloads and the auth endpoints; answering any of
  // it from here — even to report being offline — would break a live turn.
  if (url.pathname.startsWith("/api/")) return;

  // Only real page loads. Next's client-side routing fetches RSC payloads with
  // the same origin and a normal fetch mode, so this test is what keeps an
  // HTML error page out of the router.
  if (req.mode !== "navigate") return;

  event.respondWith(
    fetch(req).catch(() => {
      // A response from the server, even a 500, is the server's to explain.
      // Only a genuine network failure lands here.
      return new Response(OFFLINE_HTML, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }),
  );
});

/*
 * Inline rather than a precached /offline route: a page fetched at install
 * time is one more thing that can fail, or go stale, or quietly capture a
 * branded screen from a portal the device later stops using. This needs no
 * network and no cache, and it is the only screen in the app allowed to work
 * without either. Colours mirror the app's own tokens (globals.css) in both
 * themes so it does not flash white on a dark phone.
 */
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>No connection</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #14171c;
    --muted: #687180;
    --surface: #f2f4f7;
    --border: #e3e7ec;
    --accent: #5b7aa6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d0f13;
      --fg: #f3f4f6;
      --muted: #9aa1ad;
      --surface: #181b22;
      --border: #242a35;
      --accent: #88a6cf;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem calc(1.5rem + env(safe-area-inset-right)) calc(1.5rem + env(safe-area-inset-bottom)) calc(1.5rem + env(safe-area-inset-left));
    background: var(--bg);
    color: var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%;
    max-width: 22rem;
    text-align: center;
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 1rem;
    padding: 2rem 1.5rem;
  }
  svg { color: var(--muted); }
  h1 { margin: 1rem 0 0; font-size: 1.0625rem; font-weight: 600; }
  p { margin: 0.5rem 0 0; font-size: 0.875rem; line-height: 1.5; color: var(--muted); }
  button {
    margin-top: 1.5rem;
    width: 100%;
    padding: 0.625rem 1rem;
    font: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    color: #fff;
    background: var(--accent);
    border: 0;
    border-radius: 999px;
    cursor: pointer;
  }
  button:active { opacity: 0.85; }
</style>
</head>
<body>
  <main>
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M1 1l22 22"/>
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
      <path d="M10.71 5.05A16 16 0 0 1 22.58 9"/>
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
      <path d="M12 20h.01"/>
    </svg>
    <h1>You're offline</h1>
    <p>Your assistant needs a connection. Check your signal or Wi‑Fi, then try again.</p>
    <button type="button" onclick="location.reload()">Try again</button>
  </main>
</body>
</html>`;

// Referenced so the version is part of the file's bytes: a changed VERSION is
// what makes the browser see a new worker and replace the old one.
self.OPNINFER_SW_VERSION = VERSION;
