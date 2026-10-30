const VERSION = "sync-v2-45";
const CACHE = `lighting-dashboard-${VERSION}`;
const MANIFEST_KEY = "/__sync-v2-cache-manifest";
const REQUIRED = [
  "/",
  "/api/script",
  "/lt-script.pdf",
  "/script-search-index.json",
  "/script/reading.json",
  "/fonts/open-sans-extrabold.woff",
  "/site.webmanifest",
  "/brand-mark.png",
  "/lx-icon-192.png",
  "/lx-icon-512.png",
  "/pdf.worker.min.mjs",
];

// Bound simultaneous downloads/hash buffers so a cold install does not wait
// for every independent asset in series or allocate the whole cache at once.
async function mapConcurrent(values, work, concurrency = 4) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await work(values[index]);
    }
  }));
  return results;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function responseIdentity(response) {
  const bytes = await response.clone().arrayBuffer();
  return { byteLength: bytes.byteLength, sha256: hex(await crypto.subtle.digest("SHA-256", bytes)) };
}

async function cacheResponse(cache, url, response) {
  if (!response.ok) throw new Error(`Offline asset ${url} returned ${response.status}.`);
  const identity = await responseIdentity(response);
  await cache.put(url, response);
  return { url, ...identity };
}

async function cacheManifest(cache) {
  const response = await cache.match(MANIFEST_KEY);
  if (!response) return null;
  const value = await response.json().catch(() => null);
  if (value?.version !== VERSION || !Array.isArray(value?.entries)) return null;
  if (!value.entries.every((entry) => typeof entry?.url === "string" && Number.isSafeInteger(entry?.byteLength) && entry.byteLength >= 0 && /^[a-f0-9]{64}$/.test(entry?.sha256))) return null;
  return value;
}

async function verifyCache(cache) {
  const manifest = await cacheManifest(cache);
  if (!manifest || manifest.entries.length === 0) return false;
  const checked = await mapConcurrent(manifest.entries, async (entry) => {
    const response = await cache.match(entry.url);
    if (!response) return false;
    const identity = await responseIdentity(response);
    return identity.byteLength === entry.byteLength && identity.sha256 === entry.sha256;
  });
  return checked.every(Boolean);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const shell = await fetch("/", { cache: "reload" });
    if (!shell.ok) throw new Error("The application shell could not be cached.");
    const html = await shell.clone().text();
    const discovered = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1].replaceAll("&amp;", "&")).filter((url) => url.startsWith("/") && !url.startsWith("/api/") && !url.startsWith("/__sync-v2-"));
    const urls = [...new Set([...REQUIRED, ...discovered])];
    const entries = [await cacheResponse(cache, "/", shell)];
    entries.push(...await mapConcurrent(urls.filter((item) => item !== "/"), async (url) => cacheResponse(cache, url, await fetch(url, { cache: "no-cache" }))));
    await cache.put(MANIFEST_KEY, new Response(JSON.stringify({ version: VERSION, entries }), { headers: { "content-type": "application/json" } }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    if (!await verifyCache(cache)) throw new Error("Offline cache generation is incomplete or changed.");
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("lighting-dashboard-") && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

let verification = null;
self.addEventListener("message", (event) => {
  if (event.data?.type !== "SYNC_V2_CACHE_STATUS" || !event.ports?.[0]) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    verification ??= verifyCache(cache).finally(() => { verification = null; });
    const complete = await verification;
    event.ports[0].postMessage({ type: "SYNC_V2_CACHE_STATUS", version: VERSION, complete });
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/script") return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (await caches.open(CACHE)).match("/") ?? Response.error()));
    return;
  }
  if (url.pathname === "/api/script") {
    event.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match("/api/script")) ?? fetch(request)));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    return cached ?? fetch(request);
  })());
});
