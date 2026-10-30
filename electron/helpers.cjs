const testUrl = process.env.LT_DESKTOP_TEST_URL;
if (testUrl && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(testUrl)) {
  throw new Error("LT_DESKTOP_TEST_URL must be a loopback HTTP origin with a port.");
}
const WORKSPACE_URL = testUrl || "app://desktop/";

function isWorkspaceUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "app:" ? url.hostname === "desktop" : url.origin === WORKSPACE_URL) && !url.username && !url.password;
  } catch { return false; }
}

function isExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

// Runs in the browser: the site's offline shell omits scripts loaded on demand.
function cacheDesktopAssets() {
  if (!navigator.serviceWorker) return;
  void navigator.serviceWorker.ready.then(async () => {
    const name = (await caches.keys()).filter((key) => key.startsWith("lighting-dashboard-sync-v2-")).at(-1);
    if (!name) return;
    const cache = await caches.open(name);
    const pending = new Set();
    const stored = new Set();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const url = new URL(entry.name);
        if (url.origin !== location.origin || !(url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/assets/")) || pending.has(url.href) || stored.has(url.href)) continue;
        pending.add(url.href);
        void (async () => {
          if (!await cache.match(url.href)) {
            const response = await fetch(url.href, { cache: "force-cache" });
            if (response.ok) await cache.put(url.href, response);
          }
          if (await cache.match(url.href)) stored.add(url.href);
        })().catch(() => {}).finally(() => pending.delete(url.href));
      }
    });
    observer.observe({ type: "resource", buffered: true });
  }).catch(() => {});
}

function restoreBounds(saved, displays) {
  const valid = ["x", "y", "width", "height"].every((key) => Number.isFinite(saved[key]));
  const area = (valid && displays.find(({ workArea: a }) =>
    saved.x + saved.width > a.x + 80 && saved.x < a.x + a.width - 80 &&
    saved.y + saved.height > a.y + 80 && saved.y < a.y + a.height - 80))?.workArea ?? displays[0].workArea;
  const width = Math.min(area.width, Math.max(900, valid ? saved.width : 1440));
  const height = Math.min(area.height, Math.max(650, valid ? saved.height : 960));
  return {
    width, height,
    minWidth: Math.min(900, area.width), minHeight: Math.min(650, area.height),
    x: Math.round(Math.max(area.x, Math.min(valid ? saved.x : area.x + (area.width - width) / 2, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(valid ? saved.y : area.y + (area.height - height) / 2, area.y + area.height - height))),
  };
}

module.exports = { WORKSPACE_URL, isWorkspaceUrl, isExternalUrl, cacheDesktopAssets, restoreBounds };
