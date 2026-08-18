/**
 * Erase pipeline orchestration (design §2.4, §5, §4.1).
 *
 * Runs on the main thread: computes the mask bbox, plans tiles, feeds them to
 * the inference Worker (transferable tensors, capped concurrency), blends
 * tile outputs into a full-size result buffer, and reports progress.
 * Cancellation keeps the completed intermediate results.
 */
import { maskBBox, type MaskRect } from './mask';
import { accumulateTile, finalizeRegion, planTiles, sampleContext, type Tile } from './tiler';
import type { Action, AppState, Store } from './store';
import type { CanvasController } from '../ui/canvas';
import type { ProgressBar } from '../ui/components/progressBar';
import { bitmapToImageData } from './image';
import { TILING_DEFAULTS, MODEL_INIT_TIMEOUT_MS } from '../config/constants';
import {
  cacheModel,
  DownloadCancelledError,
  DownloadError,
  idbGetModel,
  isModelCached,
} from '../storage/modelCache';

/**
 * Diagnostics switch: append `?wasm=1` to force the WASM execution provider
 * (bypasses WebGPU) so GPU-specific artifacts can be compared directly.
 */
const forceWasm = typeof location !== 'undefined' && new URLSearchParams(location.search).get('wasm') === '1';

/**
 * True when WebGPU is available. Adapters WITHOUT `shader-f16` are still used:
 * onnxruntime-web ≥1.27 transparently falls back to fp32 shaders for fp32
 * models (verified: quality runs on GPU), and only fp16 tensors require f16 —
 * session.ts backstops any init failure by retrying on WASM.
 */
function hasWebgpu(): boolean {
  return !forceWasm && 'gpu' in navigator;
}

export interface InferenceDeps {
  store: Store<AppState, Action>;
  canvas: CanvasController;
  progress: ProgressBar;
  onReady: () => void;
  translate: (key: Parameters<typeof import('../i18n').t>[0], vars?: Record<string, string | number>) => string;
  showMessage: (title: string, text: string) => void;
}

interface WorkerMsg {
  type: 'ready' | 'init-error' | 'result' | 'error' | 'init-progress';
  id?: number;
  message?: string;
  stage?: import('../wasm/worker').InitStage;
  detail?: 'start' | 'done';
  bytes?: number;
  ms?: number;
  output?: Float32Array;
  outW?: number;
  outH?: number;
}

/** A tile whose inference result has arrived. */
interface CompletedTile extends Tile {
  output: Float32Array;
  outW: number;
  outH: number;
}

export class InferenceCancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'InferenceCancelledError';
  }
}

export function initInference(deps: InferenceDeps): { run: (options?: { bitmap?: ImageBitmap; label?: string }) => Promise<void>; cancel: () => void } {
  let worker: Worker | null = null;
  let workerModelId: string | null = null;
  let active = false;
  let cancelled = false;
  let statusLabel = deps.translate('inference.title');

  // per-run state
  let regionBuf: Float32Array | null = null;
  let regionW = 0;
  let regionRect: MaskRect = { x: 0, y: 0, w: 0, h: 0 };
  let resultImageData: ImageData | null = null;
  let sourceImageData: ImageData | null = null;

  // tile.index → promise plumbing
  const pending = new Map<number, { reject: (e: Error) => void }>();
  const pendingResolvers = new Map<number, (msg: WorkerMsg) => void>();

  function setStatus(status: AppState['inference']['status'], done?: number, total?: number, message?: string): void {
    deps.store.dispatch({ type: 'INFERENCE_STATUS', status, done, total, message });
  }

  function ensureWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL('../wasm/worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const msg = e.data;
      if (msg.type === 'result' && msg.id !== undefined && msg.output) {
        const resolve = pendingResolvers.get(msg.id);
        pendingResolvers.delete(msg.id);
        pending.delete(msg.id);
        resolve?.(msg);
      } else if (msg.type === 'error' && msg.id !== undefined) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        pendingResolvers.delete(msg.id);
        p?.reject(new Error(msg.message ?? 'inference error'));
      } else if (msg.type === 'init-error') {
        setStatus('error', undefined, undefined, msg.message);
        deps.showMessage(deps.translate('inference.error'), msg.message ?? '');
      } else if (msg.type === 'init-progress') {
        const key = msg.stage === 'fetch' ? 'inference.initFetching' : 'inference.parsing';
        setStatus('running', 0, 1, deps.translate(key));
      }
    };
    worker.onerror = (e) => {
      setStatus('error', undefined, undefined, e.message);
      deps.showMessage(deps.translate('inference.error'), e.message);
    };
    return worker;
  }

  /** Initialize the session in the worker for `spec`; no-op if already loaded. */
  async function ensureSession(spec: AppState['model']['selected']): Promise<void> {
    if (!spec) throw new Error('no model');
    const w = ensureWorker();
    if (workerModelId === spec.id) return;

    // Live diagnostics: show the current init stage + elapsed seconds on the
    // progress bar so a hang is visible without opening DevTools.
    let stageLabel = deps.translate('inference.initializing');
    let stageStart = performance.now();
    const elapsedTick = setInterval(() => {
      const s = Math.round((performance.now() - stageStart) / 1000);
      setStatus('running', 0, 1, deps.translate('inference.elapsed', { stage: stageLabel, s }));
    }, 1000);
    const stopTick = (): void => clearInterval(elapsedTick);

    // WebGPU capability check happens here (not inside the promise below) so
    // the check stays in this async function; the promise executor isn't async.
    const useWebgpu = hasWebgpu();
    setStatus('running', 0, 1, stageLabel);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopTick();
        w.removeEventListener('message', onMsg);
        fn();
      };
      const onMsg = (e: MessageEvent<WorkerMsg>): void => {
        const d = e.data;
        if (d.type === 'ready') {
          finish(() => resolve());
        } else if (d.type === 'init-error') {
          finish(() => reject(new Error(d.message)));
        } else if (d.type === 'init-progress') {
          if (d.stage === 'fetch') {
            stageLabel = deps.translate('inference.initFetching');
          } else if (d.stage === 'parse') {
            stageLabel = deps.translate('inference.parsing');
          }
          if (d.detail === 'done' && d.ms !== undefined) {
            stageLabel = `${stageLabel} ✓ ${(d.ms / 1000).toFixed(1)}s`;
          }
          stageStart = performance.now();
          setStatus('running', 0, 1, stageLabel);
        }
      };
      // Hard cap on session init (model parse + wasm bring-up); if it never
      // resolves, kill the worker so a retry starts fresh instead of hanging.
      const timer = setTimeout(() => {
        finish(() => {
          worker?.terminate();
          worker = null;
          workerModelId = null;
          reject(new Error(deps.translate('inference.initTimeout')));
        });
      }, MODEL_INIT_TIMEOUT_MS);
      w.addEventListener('message', onMsg);
      if (spec.url) {
        w.postMessage({ type: 'init', modelUrl: spec.url, threads: spec.threads, useWebgpu });
      } else {
        // uploaded model: read bytes from IndexedDB and transfer them
        void idbGetModel(spec.id).then((bytes) => {
          if (!bytes) {
            finish(() => reject(new Error('uploaded model bytes missing')));
            return;
          }
          w.postMessage({ type: 'init', modelBytes: bytes, threads: spec.threads, useWebgpu }, [bytes]);
        });
      }
    });
    workerModelId = spec.id;
  }

  /**
   * Ensure the selected model's bytes are cached before the Worker loads it.
   * A URL model that isn't cached yet is downloaded HERE with visible progress
   * (the Worker's own fetch would otherwise stall with no user feedback).
   * Uploaded models already live in IndexedDB.
   */
  async function ensureModelDownloaded(spec: AppState['model']['selected']): Promise<void> {
    if (!spec || !spec.url) return;
    if (await isModelCached(spec.url)) return;
    if (!navigator.onLine) {
      throw new DownloadError('offline', 'offline');
    }
    const name = spec.nameKey ? deps.translate(spec.nameKey as never) : (spec.name ?? spec.id);
    const ac = new AbortController();
    deps.progress.show({
      title: deps.translate('model.download.progress', { name, loaded: 0, total: Math.round(spec.sizeMB), pct: 0 }),
      kind: 'download',
      cancel: () => ac.abort(),
    });
    try {
      await cacheModel(spec.url, (loaded, total) => {
        const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
        deps.progress.update({
          title: deps.translate('model.download.progress', { name, loaded: mb(loaded), total: mb(total), pct }),
          pct,
        });
      }, ac.signal);
    } finally {
      // hand the progress bar back to inference mode (tile progress)
      deps.progress.show({ title: statusLabel, kind: 'inference', cancel });
    }
    deps.store.dispatch({ type: 'MODEL_CACHE_STATUS', id: spec.id, status: 'cached' });
  }

  function inferTile(tile: Tile): Promise<CompletedTile> {
    const w = ensureWorker();
    return new Promise((resolve, reject) => {
      if (!sourceImageData) {
        reject(new Error('no source image'));
        return;
      }
      const s = deps.store.getState();
      const tensor = new Float32Array(4 * tile.feedH * tile.feedW);
      sampleContext(sourceImageData, s.mask!, tile, tensor);
      pending.set(tile.index, { reject });
      pendingResolvers.set(tile.index, (msg) => {
        if (msg.output) {
          resolve({ ...tile, output: msg.output, outW: msg.outW!, outH: msg.outH! });
        } else {
          reject(new Error('missing output'));
        }
      });
      w.postMessage({ type: 'infer', id: tile.index, tensor, feedW: tile.feedW, feedH: tile.feedH }, [tensor.buffer]);
    });
  }

  /** Paste the currently-blended region (partial weights) into the result and show it. */
  function paintRegion(): void {
    if (!resultImageData || !regionBuf || !sourceImageData) return;
    finalizeRegion(regionBuf, regionW, regionRect, sourceImageData, resultImageData);
    deps.store.dispatch({ type: 'RESULT_SET', result: resultImageData });
    deps.canvas.setResult(resultImageData);
  }

  async function run(options: { bitmap?: ImageBitmap; label?: string } = {}): Promise<void> {
    const s = deps.store.getState();
    if (active) return;
    const target = options.bitmap ?? s.image?.bitmap ?? null;
    statusLabel = options.label ?? deps.translate('inference.title');
    // Report a failure state on the guard paths so callers (e.g. the batch
    // loop) can detect that nothing was produced instead of seeing 'done'.
    if (!target || !s.mask) {
      setStatus('error', undefined, undefined, deps.translate('export.needImage'));
      deps.showMessage(deps.translate('export.needImage'), '');
      return;
    }
    const bbox = maskBBox(s.mask, s.maskWidth, s.maskHeight);
    if (!bbox) {
      setStatus('error', undefined, undefined, deps.translate('inference.emptyMask'));
      deps.showMessage(deps.translate('inference.emptyMask'), '');
      return;
    }
    const model = s.model.selected;
    if (!model) {
      setStatus('error', undefined, undefined, deps.translate('inference.noModel'));
      deps.showMessage(deps.translate('inference.noModel'), '');
      return;
    }

    active = true;
    cancelled = false;
    const { region, tiles } = planTiles(bbox, s.maskWidth, s.maskHeight, {
      padding: TILING_DEFAULTS.padding,
      overlap: TILING_DEFAULTS.overlap,
      align: TILING_DEFAULTS.align,
      inputSize: model.inputSize,
      fixedInput: model.fixedInput ?? false,
    });

    regionBuf = new Float32Array(region.w * region.h * 4);
    regionW = region.w;
    regionRect = region.rect;
    sourceImageData = bitmapToImageData(target);
    resultImageData = bitmapToImageData(target);
    deps.canvas.setResult(resultImageData);

    const total = tiles.length;
    let done = 0;
    setStatus('running', 0, total, statusLabel);

    try {
      await ensureModelDownloaded(model);
      await ensureSession(model);
      // WebGPU executes tiles serially on its queue (parallel submits just
      // queue up and multiply memory), so cap concurrency at 1 on GPU devices;
      // WASM keeps the tile-level parallelism (design §13: desktop 4, mobile 2).
      const concurrency = hasWebgpu()
        ? 1
        : window.matchMedia('(pointer: coarse)').matches
          ? TILING_DEFAULTS.mobileConcurrency
          : TILING_DEFAULTS.concurrency;
      const overlap = TILING_DEFAULTS.overlap;
      const tRunStart = performance.now();

      const runTile = (tile: Tile): Promise<void> =>
        inferTile(tile)
          .then((r) => {
            accumulateTile(regionBuf!, regionW, regionRect, tile, r.output, r.outW, r.outH, overlap);
            done++;
            const avg = ((performance.now() - tRunStart) / 1000 / done).toFixed(1);
            setStatus('running', done, total, deps.translate('inference.tileAvg', { s: avg }));
            paintRegion();
          })
          .catch((e: Error) => {
            if (cancelled) return; // swallow post-cancel errors
            throw e;
          });

      // fixed-concurrency queue: at most `concurrency` tiles in flight
      let next = 0;
      const pump = async (): Promise<void> => {
        while (!cancelled && next < tiles.length) {
          const tile = tiles[next++]!;
          await runTile(tile);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, pump));

      if (cancelled) {
        setStatus('idle', done, total, deps.translate('inference.cancelled'));
        return;
      }
      setStatus('done', total, total);
    } catch (e) {
      if (e instanceof DownloadCancelledError) {
        setStatus('idle', undefined, undefined, deps.translate('inference.cancelled'));
        deps.showMessage(deps.translate('inference.title'), deps.translate('model.download.cancelled'));
      } else if (e instanceof DownloadError) {
        const key =
          e.kind === 'offline' ? 'model.download.fail.offline'
          : e.kind === 'quota' ? 'model.download.fail.quota'
          : e.kind === 'network' ? 'model.download.fail.network'
          : 'model.download.fail.cache';
        setStatus('error', undefined, undefined, deps.translate(key));
        deps.showMessage(deps.translate('model.download.title'), deps.translate(key));
      } else {
        const message = e instanceof Error ? e.message : String(e);
        setStatus('error', undefined, undefined, message);
        deps.showMessage(deps.translate('inference.error'), message);
      }
    } finally {
      active = false;
      pending.clear();
      pendingResolvers.clear();
      deps.onReady();
    }
  }

  function cancel(): void {
    if (!active) return;
    cancelled = true;
    worker?.postMessage({ type: 'cancel' });
    for (const [, p] of pending) p.reject(new InferenceCancelledError());
    pending.clear();
    pendingResolvers.clear();
  }

  return { run, cancel };
}
