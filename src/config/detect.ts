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
      } else if (caps.webgpu) {
        r.push({ key: 'model.why.memory' });
      }
    } else if (spec.id === 'balanced') {
      if (caps.webgpu) {
        if (!recommendedId) recommendedId = spec.id;
      } else {
        r.push({ key: 'model.why.noGpu' });
        if (caps.mobile) r.push({ key: 'model.why.mobile' });
        if (caps.deviceMemoryGB !== null && caps.deviceMemoryGB <= 4) r.push({ key: 'model.why.memory' });
      }
    } else {
      // quality
      r.push({ key: 'model.why.noGpu' });
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
