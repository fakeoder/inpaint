/**
 * Model smoke test (design §6.1): run a solid-color inference and check the
 * output shape before accepting a custom model. Runs in a throwaway Worker.
 */
import type { ModelSpec } from '../config/models';
import { idbGetModel } from '../storage/modelCache';

interface SmokeMsg {
  type: 'ready' | 'init-error' | 'result' | 'error';
  message?: string;
  outW?: number;
  outH?: number;
  output?: Float32Array;
}

export class SmokeTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmokeTestError';
  }
}

/** Returns { outH, outW } of the model output for a solid-color input. */
export async function smokeTestModel(spec: ModelSpec, timeoutMs = 120_000): Promise<{ outH: number; outW: number }> {
  const w = new Worker(new URL('../wasm/worker.ts', import.meta.url), { type: 'module' });
  const timer = setTimeout(() => w.terminate(), timeoutMs);
  try {
    const size = spec.fixedInput ? spec.inputSize : 32;
    // wait for ready
    await new Promise<void>((resolve, reject) => {
      const onMsg = (e: MessageEvent<SmokeMsg>): void => {
        if (e.data.type === 'ready') {
          w.removeEventListener('message', onMsg);
          resolve();
        } else if (e.data.type === 'init-error') {
          w.removeEventListener('message', onMsg);
          reject(new SmokeTestError(e.data.message ?? 'model failed to load'));
        }
      };
      w.addEventListener('message', onMsg);
      if (spec.url) {
        w.postMessage({ type: 'init', modelUrl: spec.url, threads: 1 });
      } else {
        void idbGetModel(spec.id).then((bytes) => {
          if (!bytes) {
            reject(new SmokeTestError('model bytes missing'));
            return;
          }
          w.postMessage({ type: 'init', modelBytes: bytes, threads: 1 }, [bytes]);
        });
      }
    });

    // solid-color input: RGB 0.5, mask 1.0
    const tensor = new Float32Array(4 * size * size).fill(0.5);
    tensor.fill(1.0, 3 * size * size); // mask channel
    const result = await new Promise<SmokeMsg>((resolve, reject) => {
      const onMsg = (e: MessageEvent<SmokeMsg>): void => {
        if (e.data.type === 'result') {
          w.removeEventListener('message', onMsg);
          resolve(e.data);
        } else if (e.data.type === 'error' || e.data.type === 'init-error') {
          w.removeEventListener('message', onMsg);
          reject(new SmokeTestError(e.data.message ?? 'inference failed'));
        }
      };
      w.addEventListener('message', onMsg);
      w.postMessage({ type: 'infer', id: 0, tensor, feedW: size, feedH: size }, [tensor.buffer]);
    });

    if (!result.outW || !result.outH || result.outH % 32 !== 0 || result.outW % 32 !== 0) {
      throw new SmokeTestError(`unexpected output shape ${result.outH}×${result.outW}`);
    }
    return { outH: result.outH, outW: result.outW };
  } finally {
    clearTimeout(timer);
    w.terminate();
  }
}
