/**
 * Inference Worker (design §4.1, §13).
 *
 * The model bytes are read directly inside the Worker (Cache first, else
 * fetch) — the main thread only passes the URL, avoiding postMessage-ing
 * 62–209MB of model bytes. Tiles arrive as transferable Float32Arrays.
 *
 * Protocol (main → worker):
 *   { type: 'init', modelUrl?: string, modelBytes?: ArrayBuffer, threads }
 *   { type: 'infer', id, tensor: Float32Array, feedW, feedH }
 *   { type: 'cancel' }
 *
 * Protocol (worker → main):
 *   { type: 'ready', inputName, outputName } | { type: 'init-error', message }
 *   { type: 'result', id, output: Float32Array, outW, outH }
 *   { type: 'error', id?, message }
 */
import { createSession, runTile, type SessionHandle } from './session';
import { fetchModelBytes } from '../storage/modelCache';

type InitMsg = { type: 'init'; modelUrl?: string; modelBytes?: ArrayBuffer; threads: number; useWebgpu?: boolean };
type InferMsg = { type: 'infer'; id: number; tensor: Float32Array; feedW: number; feedH: number };
type CancelMsg = { type: 'cancel' };
type WorkerMsg = InitMsg | InferMsg | CancelMsg;

/** Progress stages reported back to the main thread during session init. */
export type InitStage = 'fetch' | 'parse';

/** Visible in the DevTools console (worker context) for diagnosing hangs. */
function log(...args: unknown[]): void {
  console.warn('[inpaint-worker]', ...args);
}

let handle: SessionHandle | null = null;
let cancelled = false;
const inFlight = new Set<number>();

// Boot diagnostics: helps judge whether threading/SIMD/WebGPU are available.
log('env:', {
  crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : 'n/a',
  hardwareConcurrency: navigator.hardwareConcurrency,
  webgpu: 'gpu' in navigator,
  userAgent: navigator.userAgent,
});

self.onmessage = async (e: MessageEvent<WorkerMsg>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      log('init: modelUrl=', msg.modelUrl, 'hasBytes=', !!msg.modelBytes, 'threads=', msg.threads, 't=', Date.now());
      post({ type: 'init-progress', stage: 'fetch', detail: 'start' });
      const tFetch = performance.now();
      const bytes = msg.modelBytes ?? (msg.modelUrl ? await fetchModelBytes(msg.modelUrl) : null);
      if (!bytes) throw new Error('no model source');
      const fetchS = ((performance.now() - tFetch) / 1000).toFixed(1);
      log(`init: model bytes ready (${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB) in ${fetchS}s`);
      post({ type: 'init-progress', stage: 'fetch', detail: 'done', bytes: bytes.byteLength, ms: Math.round(performance.now() - tFetch) });
      post({ type: 'init-progress', stage: 'parse', detail: 'start' });
      // Threading: the earlier hang was graph optimization ('all'), not pthreads —
      // session creation is 0.5s single-threaded now. Restore the model's thread
      // count when cross-origin isolation allows SharedArrayBuffer; the 120s init
      // timeout on the main thread guards against any pthread bring-up issue.
      const useWebgpu = msg.useWebgpu ?? ('gpu' in navigator);
      // Multi-threading needs SharedArrayBuffer, i.e. full cross-origin
      // isolation (COOP/COEP headers on the page AND on the /ort/ glue files —
      // see serveOrtDev). Without it, ORT falls back to single-threaded anyway,
      // so mirror that decision here instead of hard-coding 1.
      const isolated = typeof crossOriginIsolated === 'boolean' && crossOriginIsolated;
      const threads = isolated ? msg.threads : 1;
      log(`init: threads = ${threads}${isolated ? '' : ' (not cross-origin isolated)'} useWebgpu =`, useWebgpu);
      const t0 = performance.now();
      log('init: createSession start');
      handle = await createSession(bytes, threads, useWebgpu);
      const parseS = ((performance.now() - t0) / 1000).toFixed(1);
      log(`init: session created in ${parseS}s, EP = ${handle.ep}, threads = ${threads}`);
      post({ type: 'init-progress', stage: 'parse', detail: 'done', ms: Math.round(performance.now() - t0) });
      post({ type: 'ready', inputName: handle.info.inputName, outputName: handle.info.outputName, ep: handle.ep });
    } else if (msg.type === 'infer') {
      if (!handle) throw new Error('session not initialized');
      cancelled = false;
      inFlight.add(msg.id);
      const t1 = performance.now();
      log(`infer #${msg.id}: start (${msg.feedW}x${msg.feedH})`);
      const { output, outH, outW, outType } = await runTile(handle, msg.tensor, msg.feedH, msg.feedW);
      const tileS = ((performance.now() - t1) / 1000).toFixed(1);
      log(`infer #${msg.id}: done in ${tileS}s (${outW}x${outH}, type=${outType})`);
      inFlight.delete(msg.id);
      if (!cancelled) {
        // transfer the output buffer back (it's a fresh allocation)
        post({ type: 'result', id: msg.id, output, outW, outH }, [output.buffer]);
      }
    } else if (msg.type === 'cancel') {
      log('cancel received');
      cancelled = true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error:', message, err);
    if (msg.type === 'init') {
      post({ type: 'init-error', message });
    } else if (msg.type === 'infer') {
      inFlight.delete(msg.id);
      post({ type: 'error', id: msg.id, message });
    }
  }
};

function post(msg: unknown, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}
