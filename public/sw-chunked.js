// public/sw-chunked.js
// Starter service worker that proxies /cached-files/<rootHash>.<ext> -> /api/v1/storage/:rootHash
// and caches returned range bytes into IndexedDB under "og-chunks-db"/"chunks" store.

const SW_DB = 'og-chunks-db';
const CHUNK_STORE = 'chunks';
const META_STORE = 'meta';

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(SW_DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result?.value ?? null);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(store, key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

self.addEventListener('install', (evt) => {
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(self.clients.claim());
});

function parseCachedUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    if (parts[1] !== 'cached-files') return null;
    const filename = parts.slice(2).join('/');
    const dot = filename.indexOf('.');
    const root = dot === -1 ? filename : filename.slice(0, dot);
    const ext = dot === -1 ? '' : filename.slice(dot + 1);
    return { root, ext, filename };
  } catch {
    return null;
  }
}

self.addEventListener('fetch', (evt) => {
  const parsed = parseCachedUrl(evt.request.url);
  if (!parsed) return; // normal request
  const rangeHeader = evt.request.headers.get('range');
  evt.respondWith(handleCachedFetch(parsed.root, parsed.ext, evt.request, rangeHeader));
});

async function handleCachedFetch(rootHash, ext, request, rangeHeader) {
  // quick metadata fetch (HEAD) to populate content-type/length
  let meta = await idbGet(META_STORE, rootHash);
  if (!meta) {
    try {
      const head = await fetch(`/api/v1/storage/${rootHash}`, { method: 'HEAD' });
      if (head.ok) {
        const contentType = head.headers.get('content-type') || `video/${ext || 'mp4'}`;
        const size = head.headers.get('content-length') ? parseInt(head.headers.get('content-length'), 10) : null;
        meta = { contentType, size };
        await idbPut(META_STORE, rootHash, meta);
      }
    } catch (e) {
      // ignore
    }
  }
  const contentType = meta?.contentType || 'application/octet-stream';

  // If no Range requested, just return full response proxied (could stream and store if desired)
  if (!rangeHeader) {
    const resp = await fetch(`/api/v1/storage/${rootHash}`);
    // ensure CORS
    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(await resp.arrayBuffer(), { status: resp.status, statusText: resp.statusText, headers });
  }

  // forward Range to gateway and cache returned chunk
  const gatewayResp = await fetch(`/api/v1/storage/${rootHash}`, { headers: { Range: rangeHeader } });
  if (!gatewayResp.ok && gatewayResp.status !== 206) {
    return gatewayResp;
  }
  const buf = await gatewayResp.arrayBuffer();
  // compute chunk key
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  let start = 0;
  let end = (meta?.size ? meta.size - 1 : '') ;
  if (m) {
    start = m[1] === '' ? 0 : parseInt(m[1], 10);
    end = m[2] === '' ? (start + buf.byteLength - 1) : parseInt(m[2], 10);
  }
  const chunkKey = `${rootHash}:${start}-${end}`;
  // store chunk
  try {
    await idbPut(CHUNK_STORE, chunkKey, buf);
  } catch (e) {
    // ignore storage errors (quota)
  }

  // forward the response (preserve headers)
  const headers = new Headers(gatewayResp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(buf, { status: gatewayResp.status, statusText: gatewayResp.statusText, headers });
}
