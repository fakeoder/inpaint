/**
 * ORT session creation + tensor helpers (design §4.1).
 *
 * This module runs ONLY inside the Worker: onnxruntime lives in the worker,
 * the main thread never touches model tensors.
 *
 * Imports from `onnxruntime-web/webgpu` — the entry that registers both the
 * WebGPU and the WASM execution providers. On WebGPU-capable devices (design
 * §6.5: `navigator.gpu` present) we run tiles on the GPU (tens of × faster);
 * the `wasm` EP in the provider list is the automatic per-op fallback. The
 * runtime wasm (`ort-wasm-simd-threaded.asyncify.*`) is served from /ort/.
 */
import * as ort from 'onnxruntime-web/webgpu';

export interface SessionInfo {
  inputName: string;
  outputName: string;
}

/** The execution provider actually used for inference (wasm = CPU). */
export type ExecProvider = 'webgpu' | 'wasm';

export interface SessionHandle {
  session: ort.InferenceSession;
  info: SessionInfo;
  ep: ExecProvider;
}

/** Create a session from model bytes. */
export async function createSession(
  modelBytes: ArrayBuffer,
  threads: number,
  useWebgpu: boolean,
): Promise<SessionHandle> {
  ort.env.wasm.wasmPaths = '/ort/';
  ort.env.wasm.numThreads = threads;
  const options: ort.InferenceSession.SessionOptions = {
    // No graph optimization: for an already-quantized/exported LaMa model the
    // optimizer passes add pure parse cost with almost no runtime win, and the
    // constant-folding pass is one of the slowest steps on multi-hundred-MB
    // graphs under WASM. Parsing speed matters far more here.
    graphOptimizationLevel: 'disabled',
  };
  const providers: ort.InferenceSession.ExecutionProviderConfig[] = useWebgpu
    ? ['webgpu', 'wasm']
    : ['wasm'];
  let session: ort.InferenceSession;
  let ep: ExecProvider = 'webgpu';
  try {
    session = await ort.InferenceSession.create(modelBytes, {
      ...options,
      executionProviders: providers,
    });
  } catch (err) {
    // WebGPU backend failed to initialize (e.g. the adapter lacks `shader-f16`
    // and a kernel's shader requires it: "Program Transpose requires f16 but
    // the device does not support it"). The per-op `wasm` fallback only kicks
    // in per-kernel, NOT when whole-EP init fails, so retry on WASM alone —
    // slower, but the session (and the app) still works.
    if (!useWebgpu) throw err;
    console.warn(
      '[inpaint] WebGPU session creation failed, retrying on WASM:',
      err instanceof Error ? err.message : err,
    );
    ep = 'wasm';
    session = await ort.InferenceSession.create(modelBytes, {
      ...options,
      executionProviders: ['wasm'],
    });
  }
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new Error('model has no input/output names');
  }
  return { session, info: { inputName, outputName }, ep };
}

/**
 * Run inference on one tile. `tensor` is a [1,4,feedH,feedW] float32 NCHW
 * tensor (channels 0–2 masked RGB, 3 = binary mask). Returns the [1,3,H,W]
 * inpainted RGB output, always as float32 (converts from float16 when the EP
 * returns it — WebGPU can hand back float16 buffers, which would otherwise be
 * misread as float32 and produce corrupted/duplicated-looking output).
 */
export async function runTile(
  handle: SessionHandle,
  tensor: Float32Array,
  feedH: number,
  feedW: number,
): Promise<{ output: Float32Array; outH: number; outW: number; outType: string }> {
  const feeds: Record<string, ort.Tensor> = {
    [handle.info.inputName]: new ort.Tensor('float32', tensor, [1, 4, feedH, feedW]),
  };
  const results = await handle.session.run(feeds);
  const out = results[handle.info.outputName];
  if (!out) throw new Error('model produced no output');
  const shape = out.dims;
  const outH = shape[shape.length - 2] ?? feedH;
  const outW = shape[shape.length - 1] ?? feedW;
  const data = out.data as ArrayBufferView;
  if (out.type === 'float32') {
    return { output: data as Float32Array, outH, outW, outType: out.type };
  }
  if (out.type === 'float16') {
    return { output: float16ToFloat32(data as Uint16Array), outH, outW, outType: out.type };
  }
  throw new Error(`unsupported output tensor type: ${out.type}`);
}

/** Convert a float16 buffer (Uint16Array of f16 bit patterns) to float32. */
export function float16ToFloat32(src: Uint16Array): Float32Array {
  const dst = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const u = src[i]!;
    const sign = (u >> 15) & 1;
    const exp = (u >> 10) & 0x1f;
    const frac = u & 0x3ff;
    let v: number;
    if (exp === 0) {
      v = frac === 0 ? 0 : (frac / 1024) * Math.pow(2, -14);
    } else if (exp === 31) {
      v = frac === 0 ? Infinity : NaN;
    } else {
      v = (1 + frac / 1024) * Math.pow(2, exp - 15);
    }
    dst[i] = sign ? -v : v;
  }
  return dst;
}
