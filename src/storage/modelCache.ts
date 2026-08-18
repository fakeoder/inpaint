/**
 * Model caching (design §6.3/§6.4).
 *
 * URL models live in the Cache API (key = URL, versioned bucket); uploaded
 * models live in IndexedDB (no URL exists). On Cache write failure (Safari
 * has historically had Cache API quota/stability issues) we fall back to
 * IndexedDB for the bytes.
 *
 * Downloads stream the response straight into the cache while only counting
 * bytes — never accumulating the whole model in JS memory (~200MB peak saved).
 */
import { MODEL_CACHE_VERSION, IDB_NAME, IDB_MODEL_STORE } from '../config/constants';

export class DownloadCancelledError extends Error {
  constructor() {
    super('download cancelled');
    this.name = 'DownloadCancelledError';
  }
}

export type DownloadFailKind = 'offline' | 'network' | 'quota' | 'cache';

export class DownloadError extends Error {
  constructor(public kind: DownloadFailKind, message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

const cacheName = () => MODEL_CACHE_VERSION;

/* ── IndexedDB (uploaded models + Cache-API fallback) ───────── */

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_MODEL_STORE)) {
        req.result.createObjectStore(IDB_MODEL_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function idbRequest<T>(store: 'readonly' | 'readwrite', fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(IDB_MODEL_STORE, store);
    const req = fn(tx.objectStore(IDB_MODEL_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function idbPutModel(key: string, bytes: ArrayBuffer): Promise<void> {
  await idbRequest('readwrite', (s) => s.put(bytes, key));
}

export async function idbGetModel(key: string): Promise<ArrayBuffer | null> {
  const v = await idbRequest<ArrayBuffer | undefined>('readonly', (s) => s.get(key));
  return v ?? null;
}

export async function idbDeleteModel(key: string): Promise<void> {
  await idbRequest('readwrite', (s) => s.delete(key));
}

/* ── Download with progress (design §6.4) ───────────────────── */

const DOWNLOAD_TIMEOUT_MS = 180_000; // 3 min hard cap; HF can be slow or unreachable (§6.2)

/** Combine an optional caller signal with a timeout (timeout wins). */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; clear: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('download timeout')), ms);
  const onAbort = (): void => ac.abort();
  signal?.addEventListener('abort', onAbort);
  return {
    signal: ac.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

export async function downloadWithProgress(
  url: string,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = withTimeout(signal, DOWNLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: timeout.signal });
  } catch (e) {
    if (signal?.aborted) throw new DownloadCancelledError();
    if (typeof navigator !== 'undefined' && !navigator.onLine) throw new DownloadError('offline', 'offline');
    throw new DownloadError('network', String(e));
  } finally {
    timeout.clear();
  }
  if (!res.ok || !res.body) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) throw new DownloadError('offline', 'offline');
    throw new DownloadError('network', `HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = res.body.getReader();
  let loaded = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(new DownloadCancelledError());
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      loaded += value.byteLength;
      onProgress(loaded, total);
      controller.enqueue(value);
    },
    cancel() {
      return reader.cancel();
    },
  });
  return new Response(stream, { status: 200, headers: res.headers });
}

async function cachePutStream(cache: Cache, url: string, res: Response): Promise<void> {
  await cache.put(url, res);
}

/** Download a model and store it in the Cache API (IndexedDB fallback). */
export async function cacheModel(
  url: string,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await downloadWithProgress(url, onProgress, signal);
  const cache = await caches.open(cacheName());
  try {
    await cachePutStream(cache, url, res);
  } catch {
    // Cache API failure (Safari) → IndexedDB fallback (design §6.3)
    try {
      const bytes = await res.clone().arrayBuffer();
      await idbPutModel(url, bytes);
    } catch {
      throw new DownloadError('quota', 'cache write failed');
    }
  }
}

/* ── Cache lookup / delete ──────────────────────────────────── */

export async function isModelCached(url: string): Promise<boolean> {
  const cache = await caches.open(cacheName());
  return (await cache.match(url)) !== undefined;
}

export async function deleteCachedModel(url: string): Promise<void> {
  const cache = await caches.open(cacheName());
  await cache.delete(url);
  await idbDeleteModel(url).catch(() => {});
}

/**
 * Get a model's bytes: Cache first, else IndexedDB fallback, else fetch from
 * the network (and write into the cache). Used by the Worker (design §4.1:
 * the model file is read directly inside the Worker).
 */
export async function fetchModelBytes(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const cache = await caches.open(cacheName());
  const hit = await cache.match(url);
  if (hit) {
    const bytes = await hit.arrayBuffer();
    if (bytes.byteLength > 0) return bytes;
  }
  const idb = await idbGetModel(url);
  if (idb) return idb;
  const res = await downloadWithProgress(url, onProgress ?? (() => {}), signal);
  const bytes = await res.arrayBuffer();
  // best-effort cache write; failure is non-fatal (we already have the bytes)
  try {
    const cache2 = await caches.open(cacheName());
    await cache2.put(url, new Response(bytes));
  } catch {
    await idbPutModel(url, bytes).catch(() => {});
  }
  return bytes;
}

/** Estimate storage usage (design §6.3: show cache usage in a storage panel). */
export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

/** Ask the browser to keep our cached models (design §6.3 persistence protection). */
export function requestPersistentStorage(): void {
  void navigator.storage?.persist?.().catch(() => {});
}
