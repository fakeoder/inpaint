/**
 * Capability detection & model recommendation (design §6.5).
 *
 * Runs once at startup. The recommended tier gets a badge; other tiers get a
 * reason why they're not recommended. Priority: WebGPU > memory > mobile >
 * threads.
 */
import type { ModelSpec } from './models';

export interface Capabilities {
  wasm: boolean;
  webgpu: boolean;
  /** True once the WebGPU adapter is confirmed to support `shader-f16`
   *  (async; `false` until `webgpuSupportsF16()` resolves). fp16 models
   *  (balanced) need this, fp32/int8 models (quality/lite) do not. */
  webgpuF16: boolean;
  crossOriginIsolated: boolean;
  deviceMemoryGB: number | null;
  hardwareConcurrency: number;
  mobile: boolean;
  saveData: boolean;
  effectiveType: string | null;
  online: boolean;
  /** Free storage in MB, or null if unknowable. */
  freeMB: number | null;
}

export function detectCapabilities(): Capabilities {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string; saveData?: boolean };
  };
  const ua = navigator.userAgent;
  const mobile =
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);

  return {
    wasm: typeof WebAssembly !== 'undefined',
    webgpu: 'gpu' in navigator,
    webgpuF16: webgpuF16Cache === true,
    crossOriginIsolated: typeof crossOriginIsolated === 'boolean' && crossOriginIsolated,
    deviceMemoryGB: nav.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
    mobile,
    saveData: !!nav.connection?.saveData,
    effectiveType: nav.connection?.effectiveType ?? null,
    online: navigator.onLine,
    freeMB: null, // filled async via storageEstimate()
  };
}

let webgpuF16Cache: boolean | null = null;

/** Minimal WebGPU surface we touch (the DOM lib's GPU types aren't in tsconfig). */
interface MinimalGpu {
  requestAdapter(): Promise<{ features: { has(name: string): boolean } } | null>;
}

/**
 * Whether the WebGPU adapter supports the `shader-f16` feature that ORT's
 * WebGPU EP needs for its fp16 kernels (e.g. Transpose — see design §12.2).
 * `'gpu' in navigator` is NOT enough: adapters without `shader-f16` (SwiftShader
 * software rendering, VMs, remote desktops, some Intel drivers) fail session
 * creation with "Transpose requires f16 but the device does not support it".
 * Returns false on any failure and caches the result (requestAdapter is slow-ish).
 */
export async function webgpuSupportsF16(): Promise<boolean> {
  if (webgpuF16Cache !== null) return webgpuF16Cache;
  let ok = false;
  try {
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      const gpu = (navigator as Navigator & { gpu?: MinimalGpu }).gpu;
      const adapter = await gpu?.requestAdapter();
      ok = !!adapter && adapter.features.has('shader-f16');
    }
  } catch {
    ok = false;
  }
  webgpuF16Cache = ok;
  return ok;
}

export interface TierReason {
  key: string; // i18n key
  vars?: Record<string, string | number>;
}

export interface Recommendation {
  recommendedId: string;
  reasons: Record<string, TierReason>;
}

/**
 * Decide the recommended tier and per-tier reasons. `cachedIds` lets us mark
 * offline tiers as usable when cached.
 */
export function recommendModel(
  caps: Capabilities,
  specs: ModelSpec[],
  cachedIds: Set<string>,
): Recommendation {
  const reasons: Record<string, TierReason> = {};
  let recommendedId: string | null = null;

  for (const spec of specs) {
    const r: TierReason[] = [];

    if (spec.id === 'lite') {
      if (caps.mobile) {
        if (!recommendedId) recommendedId = spec.id;
      } else if (caps.deviceMemoryGB !== null && caps.deviceMemoryGB <= 4) {
        if (!recommendedId) recommendedId = spec.id;
        r.push({ key: 'model.why.memory' });
      } else if (!caps.webgpu && !caps.mobile) {
        // WASM-only desktop: int8 is ~1.8× faster on CPU/WASM (§6.5)
        if (!recommendedId) recommendedId = spec.id;
      } else if (caps.webgpu && !caps.webgpuF16) {
        // WebGPU without shader-f16: fp16 models are hidden, int8 is the
        // fastest remaining option (and works on both GPU and CPU fallback).
        if (!recommendedId) recommendedId = spec.id;
      } else if (caps.webgpu) {
        r.push({ key: 'model.why.memory' });
      }
    } else if (spec.id === 'balanced') {
      if (caps.webgpu && caps.webgpuF16) {
        // fp16 model: fastest on GPU, but only when the adapter has `shader-f16`
        if (!recommendedId) recommendedId = spec.id;
      } else if (caps.webgpu) {
        // WebGPU but no shader-f16: fp16 weights crash session creation
        // ("Program Transpose requires f16 …") — point at quality (fp32) instead.
        r.push({ key: 'model.why.noFp16' });
      } else {
        r.push({ key: 'model.why.noGpu' });
        if (caps.mobile) r.push({ key: 'model.why.mobile' });
        if (caps.deviceMemoryGB !== null && caps.deviceMemoryGB <= 4) r.push({ key: 'model.why.memory' });
      }
    } else {
      // quality (fp32): works on any WebGPU adapter (no shader-f16 needed),
      // but when fp16 is unavailable the lite (int8) tier is the default pick.
      if (caps.webgpu && !caps.webgpuF16) {
        r.push({ key: 'model.why.int8' });
      } else {
        r.push({ key: 'model.why.noGpu' });
      }
      if (caps.deviceMemoryGB !== null && caps.deviceMemoryGB <= 4) r.push({ key: 'model.why.memory' });
    }

    if (!caps.crossOriginIsolated) {
      r.push({ key: 'model.why.threads' });
    }

    // storage / network gates
    if (!caps.online && !cachedIds.has(spec.id) && spec.url) {
      r.push({ key: 'model.why.offline' });
    } else if (caps.freeMB !== null && caps.freeMB < spec.sizeMB && !cachedIds.has(spec.id)) {
      r.push({ key: 'model.why.storage', vars: { needed: spec.sizeMB } });
    }

    if (r.length > 0) reasons[spec.id] = r[0]!;
  }

  return { recommendedId: recommendedId ?? 'lite', reasons };
}

/** Model is unusable right now (offline + not cached, or no WASM). */
export function isModelUsable(spec: ModelSpec, caps: Capabilities, cached: boolean): boolean {
  if (!caps.wasm) return false;
  if (spec.url && !cached && !caps.online) return false;
  return true;
}
