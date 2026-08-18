# inpaint — Design Document

> A static, frontend-only high-resolution object eraser for images.
> Stack: Vite + TypeScript + WebAssembly (onnxruntime-web) + LaMa.

---

## 1. Overview

### 1.1 What it does

**inpaint** runs entirely in the browser. The user paints over elements they want to remove (objects, watermarks, people), and a LaMa inpainting model running in WebAssembly fills the painted region with plausible content — an "erase" effect.

### 1.2 Key features

| Feature | Description |
| --- | --- |
| Static frontend only | No backend; images and inference stay in the browser (privacy-friendly, images never leave the device) |
| High resolution | Tiling + blending strategy works around the model's fixed input size, handling multi-megapixel images |
| WASM inference | onnxruntime-web (wasm backend), no installation required |
| Model options | Multiple LaMa model tiers (size / precision / resolution), downloaded on demand |
| Local caching | Models cached in the browser; no re-download on later visits, fully usable offline once cached |
| Download progress | Live progress bar (percentage, downloaded/total) |
| Guided 3-step UI | No sidebar chrome: 1 Import → 2 Paint over what to remove → 3 Erase & download, driven by floating controls over the canvas |
| i18n | Multi-language, extensible locale packs |
| Responsive | Works on desktop and mobile (touch drawing) |
| Light / dark mode | Follows system, with manual override, persisted |

### 1.3 Deployment

The build output is a pure static site, deployable to **Cloudflare Workers Static Assets / Pages**, served through the edge CDN.

---

## 2. Feature List

### 2.1 Image input
- Import via file picker, drag & drop, or paste (clipboard)
- Formats: JPEG / PNG / WebP (decoding uses browser capabilities; everything is normalized to an internal bitmap)
- Cap on maximum side length with a warning (prevents out-of-memory on extreme sizes)
- **Single or batch import**: the picker accepts multiple files at once; the hero hints "batch import — all images must share the same size", because one fixed-position mask is shared across the batch (see §2.6)

### 2.2 Mask editing
- Brush (round, adjustable size/hardness) and eraser
- **Real-time stroke preview**: strokes paint onto the canvas as you drag (transient stroke layer, committed on pointer-up); one-click "clear" wipes the mask so the user can redraw
- Undo / redo (mask history stack)
- One-click clear mask
- Mask bitmap kept at the image's original resolution for exact drawing

### 2.3 Model management
- Model list: name, resolution, size, recommended use case (built-in tiers + user-added models)
- Download on first use with cancel; **prompt before downloading** with model source and network requirement (see §6.4)
- Persistent cache; "delete model" to free space
- **Custom model URL**: user can paste an ONNX URL (must match the LaMa contract, see §6.1)
- **Upload local model**: pick or drag a single `.onnx` file; the upload panel shows the **model requirements** (format / input-output contract / size advice, see §6.1) to avoid mismatches
- **Current model display**: a compact model selector in the step-3 floating bar (name, size, cache state, recommended badge + one-line trade-off explanation), plus a full "model management" dialog (list, add, storage) opened with one click
- **Switch models**: one-click switch between cached models; "re-download" available for cached models (clear cache, fetch again)
- **Capability-based recommendation**: auto-picks a tier from browser capabilities (WebGPU / memory / threads / storage / network) and explains why others are not recommended (see §6.5)
- Auto-selection: default tier + manual override

### 2.4 Inference
- Tile around the mask bounding box (bbox), so very large images work
- Progress shown during inference (tiles done / total)
- Cancel anytime; completed intermediate results are kept

### 2.5 Export
- After erasing, the canvas shows the **result**; a floating **"hold to view original"** button shows the original while pressed and restores the result on release
- Export PNG / JPEG (optional quality) via a small download dialog
- Batch: download the current image individually, or bundle every result into **one ZIP** (`inpaint-batch-{n}.zip`); images without a result fall back to the original
- "Edit again" returns to the paint step with the original shown, so the mask can be refined and re-erased

### 2.6 Global
- i18n language switch (follows system + manual override)
- Light / dark theme switch (follows system + manual override, persisted)
- **Guided three-step layout**: 1 Import an image → 2 Paint over what to remove → 3 Erase & download. A step indicator (top-center, collapses to numbered dots on mobile) tracks progress; the **paint bar** (brush size/hardness, brush/eraser, undo/redo, clear, re-import) shows on step 2, the **erase bar** (model picker + erase button, with a "continue painting" escape hatch) shows on step 3, and **result actions** (view original / download / zip / edit again) float bottom-right after erasing. There is **no left toolbar and no right panel** — every control floats over the centered canvas, so the same shell works on desktop and mobile.

---

## 3. Tech Stack

| Area | Choice | Why |
| --- | --- | --- |
| Build | Vite 5 | Native ESM, instant HMR, static output — a natural fit for a frontend-only app |
| Language | TypeScript 5 (strict) | The inference pipeline and state flow are complex enough to justify strong typing |
| Inference | onnxruntime-web (wasm backend) | Runs ONNX models in-browser; mature, supports SIMD / multi-threading |
| Model | LaMa (ONNX export) | Good balance of quality and speed; open source, commercially usable |
| UI | Vanilla TS + CSS variables (no framework) | Single-purpose tool; avoids framework/virtual-DOM overhead, smallest bundle |
| State | Small custom store (immutable snapshots + subscribe) | No third-party dependency; enough for a single-page tool |
| Styling | CSS custom properties (design tokens) | Light/dark switching is just a token swap |
| Storage | Cache API (models) + localStorage (settings) | Cache API is a natural fit for fetch responses; IndexedDB as fallback |
| Deploy | Cloudflare Workers Static Assets / Pages | Static hosting + edge CDN + configurable security headers |

> **Not used**: React/Vue, state libraries, UI kits, i18n libraries, SSR/CSR frameworks. This is a single-page tool; a thin custom layer (~a few hundred lines) covers all needs with a much smaller bundle and surface area.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        UI Layer                         │
│  ┌───────────┐ ┌───────────┐ ┌─────────┐ ┌───────────┐  │
│  │ Canvas/   │ │ Panels/   │ │Progress │ │ Compare   │  │
│  │ Brush     │ │ Controls  │ │ Bar     │ │ View      │  │
│  └─────┬─────┘ └─────┬─────┘ └────┬────┘ └─────┬─────┘  │
└────────┼──────────────┼────────────┼────────────┼───────┘
         │              │            │            │
┌────────▼──────────────▼────────────▼────────────▼───────┐
│                  Store (app state)                       │
│  original / mask / result / inference / settings / model │
└───────┬──────────────────────┬─────────────────────────┘
        │                      │
┌───────▼───────────┐  ┌───────▼─────────────────────────┐
│ Image processing  │  │ Inference orchestration (main)  │
│ image.ts codec    │  │ tiler.ts tiles/blend            │
│ mask.ts mask model│  │ inpaint.ts pipeline             │
└────────────────────┘  └───────┬─────────────────────────┘
                                │ postMessage (Transferable)
┌───────────────────────────────▼─────────────────────────┐
│              Inference Worker (Web Worker)              │
│  onnxruntime-wasm session / per-tile inference /        │
│  progress reporting                                     │
└───────┬─────────────────────────────────────────────────┘
        │
┌───────▼───────────┐  ┌──────────────────────────────────┐
│ Storage layer     │  │ Model resources                  │
│ modelCache.ts     │  │ models.ts registry (URLs)        │
│ settings.ts       │  │ remote model → download → cache  │
└────────────────────┘  └──────────────────────────────────┘
```

### 4.1 Layer responsibilities & constraints

- **One-way dependencies**: UI → Store → image/inference orchestration → Worker → storage/resources.
- **Inference isolation**: onnxruntime lives only inside the Worker; the main thread never touches model tensors, so the UI stays responsive.
- **Model loading path**: the model file is read **directly inside the Worker** (check Cache first, else fetch and write to Cache); the main thread only passes the model URL — avoids postMessage-ing 62–209MB of model bytes (structured clone would double memory and stall the UI).
- **Immutable data**: bitmaps (ImageData) flow as immutable snapshots; the Worker takes ownership via `transfer` to avoid structured-cloning large objects.
- **Pure core**: `tiler` / `mask` are pure functions, easy to unit test.

---

## 5. High-Resolution Tiled Inference

### 5.1 Problem

LaMa has a fixed input size (e.g. 512×512), but user images can be 4000×3000. Naively scaling the whole image loses detail; feeding it at full size violates the model's input constraint.

### 5.2 Strategy: mask-bbox tiling + context padding + overlap blending

1. **Crop region**: take the mask's bounding box (bbox) and pad it by `padding` (default ≈ half the model input size, configurable) to get the "inference region". When the padding exceeds the image edge, **clamp to the edge and copy edge pixels** to fill the context.
2. **Tiling**: if the region is larger than the model input `S`, slide a window over it in steps of `S`; otherwise run a single tile. Tile sizes and offsets are **aligned to 32px** (LaMa inputs require H/W multiples of 32).
3. **Context expansion**: each tile is actually fed with an extra `overlap` margin; if that area is larger than the model input it is **resized to `S×S`** before inference, and the output is resized back before taking only the tile's center. LaMa is a full-image reconstruction model: **the output is the inpainted RGB directly** (`[1,3,H,W]`) — paste it back, no alpha compositing.
4. **Blending**: overlapping areas between adjacent tiles are blended with a distance-weighted linear gradient (feathering) to hide seams.
5. **Paste back**: write the blended pixels into a **full-size result buffer** (a copy of the original) at the same coordinates.
6. **Parameter tuning**: `padding` / `overlap` defaults (e.g. 32px) must be tuned against the actual model and images — too little context causes seams and artifacts.

```
Inference region (bbox + padding)
┌──────────────────────────┐
│ ┌──────┬──────┬──────┐   │
│ │ tile1│ tile2│ tile3│   │  ← each tile gets +overlap when fed
│ ├──────┼──────┼──────┤   │     only the center is kept back
│ │ tile4│ tile5│ tile6│   │     edges are feathered/blended
│ └──────┴──────┴──────┘   │
└──────────────────────────┘
```

- **Small images**: if the whole image ≤ `S`, you may resize it to the model input (faster, but detail is rebuilt at the model resolution and upscaled back); the tiled path is the default because it keeps original detail.
- Multiple tiles are submitted to the Worker in parallel, throttled by a `Promise` queue (lower concurrency on mobile).

### 5.3 Implementation notes (from field debugging)

These are concrete pitfalls found while bringing the pipeline up on real browsers; each is covered by a regression test in `tests/tiler.test.ts`.

- **Overlap the kept regions**: grid the region with `step = S − overlap`, not `step = S`. With `step = S`, adjacent tiles share an edge and the feather weight drops to 0 on both sides of it, leaving a visible seam line. Overlapping kept regions make the distance-to-edge weights sum to ~1 inside the overlap band (tile sizes stay 32-aligned).
- **Scale-map the feed when the model input is resized**: fixed-input models (lite/balanced, 512) resize a larger feed rect (e.g. 640×640) down to `S×S`. The tensor must bilinearly sample the WHOLE feed rect (`feed.x + x * feed.w / feedW`); sampling raw integer offsets reads only the top-left crop, which pasted back produces the "repeated shrunken patches" artifact.
- **The model output is CHW**: read it as `c*H*W + y*W + x`. Reading `(y*W+x)*3` as HWC misreads each pixel's RGB from one channel's consecutive pixels → smeared/repeated artifacts. Constant (all-white/all-zero) synthetic outputs hide layout bugs — tests must use channel- and space-distinct fixtures.
- **LaMa input contract**: channels 0–2 are the **masked RGB** (pixels under the mask are zeroed: `rgb * (1 − mask)`), channel 3 is the binary mask. Feeding the raw image under the mask is out-of-distribution and the model degrades to flat/blank output ("painted white").
- Session init (model parse) and per-tile inference must both be timed and surfaced in the progress bar (stage + elapsed seconds) — hangs were misdiagnosed as slowness until logs showed exactly where they stopped.

---

## 6. Model Download, Cache & Progress

### 6.1 Model Registry

Model files are **not bundled into the build**. `src/config/models.ts` maps model IDs to URLs (existing ONNX files from Hugging Face etc. work directly; for production, mirror them to your own R2/CDN — see §6.2) and they are fetched on demand:

```ts
export interface ModelSpec {
  id: string;           // 'lite'|'balanced'|'quality' for built-ins; stable id derived from URL/file name for custom models
  kind: 'builtin' | 'custom';  // where the model came from
  origin?: 'url' | 'upload';   // for custom models: remote URL or local upload
  nameKey?: string;     // i18n key for built-ins (e.g. 'model.lite.name'); custom models use `name` instead
  name?: string;        // custom model name shown in the UI
  url?: string;         // model file URL (built-in / custom url models); empty for local uploads
  inputSize: number;    // model input edge (px; the 32-aligned baseline for dynamic-size models)
  sizeMB: number;       // approximate size for display
  threads: number;      // recommended inference threads
  noteKey?: string;     // i18n key for built-ins; quality/speed note
}

// URLs point to community-packaged ONNX models (g-ronimo/lama), ready to use
export const MODEL_REGISTRY: ModelSpec[] = [
  { id: 'lite',     kind: 'builtin', url: 'https://huggingface.co/g-ronimo/lama/resolve/main/lama_512_int8.onnx', inputSize: 512, sizeMB: 62,  threads: 2, /* … */ },
  { id: 'balanced', kind: 'builtin', url: 'https://huggingface.co/g-ronimo/lama/resolve/main/lama_512_fp16.onnx', inputSize: 512, sizeMB: 107, threads: 4, /* … */ },
  { id: 'quality',  kind: 'builtin', url: 'https://huggingface.co/g-ronimo/lama/resolve/main/lama.onnx',          inputSize: 512, sizeMB: 209, threads: 4, /* … */ },
];
```

Tier rationale (sizes are community-measured; re-validate against your actual exports): **lite** = weight-only int8, fixed 512 input (~62MB), fastest and lowest memory, mobile default; **balanced** = fp16 (fixed 512 input, all-fp16 compute, ~107MB), desktop default; **quality** = fp32 (~209MB), highest quality. The UI reads `sizeMB` for display.

**User-added models**: the model panel offers two ways to add a model, and shows the **model requirements** contract before adding, to avoid mismatches:

- **Model URL**: pasting an ONNX URL creates a `kind: 'custom'`, `origin: 'url'` `ModelSpec` (`id` derived from the URL, `name` from user input, `inputSize` defaults to 512, `threads` to 4). Metadata goes to `localStorage`; model bytes go through the Cache API (key = URL).
- **Local upload**: pick or drag a single `.onnx` file (recommend ≤ 512MB), creating an `origin: 'upload'` model (`url` empty, `id` derived from file name + size). Model bytes are stored in **IndexedDB** (no URL exists, so the Cache API doesn't apply).

**Model requirements (shown inside the upload panel, i18n)**: ① single-file `.onnx` — the `.onnx` + `.onnx.data` external-weights split is not supported; ② input `[1,4,H,W]` — channels 0–2 are the masked RGB, channel 3 is the binary mask, H/W must be multiples of 32 (the fixed-512 variants require exactly 512×512); ③ output `[1,3,H,W]` inpainted RGB; ④ recommended input ≤ 512×512 and file ≤ 512MB (memory and time).

Both paths run a **smoke-test inference** on first use (run a solid-color small image and check the output shape); on failure, show "this model is not compatible" and refuse to use it. The current model is keyed by **id** (for url models the id is derived from the URL and matches the cache key; upload models use the id directly).

### 6.2 Model Sources

**Preferred: reuse community-packaged ONNX models — no self-export needed.** Use [g-ronimo/lama](https://huggingface.co/g-ronimo/lama) (Apache-2.0, verified in production by wipe.photos and others). The three tiers map 1:1 to the registry:

| Tier | File | Size (measured) | Notes |
| --- | --- | --- | --- |
| quality | `lama.onnx` | 209.2MB | Original fp32 export, dynamic size (H/W multiples of 32) |
| balanced | `lama_512_fp16.onnx` | 106.6MB | Weight-only fp16, fixed 512×512, all-fp16 compute; recommended for CPU/WASM |
| lite | `lama_512_int8.onnx` | 62.1MB | Weight-only int8, fixed 512×512; recommended for mobile / memory-constrained devices |

Download form: `https://huggingface.co/g-ronimo/lama/resolve/main/<file>`. Works directly in browser `fetch` (hf.co 302-redirects to its CDN and sends CORS headers; all three files verified reachable).

Notes:

- **Prefer single-file models**: all three tiers above are single `.onnx` files. Avoid repos that split weights into `.onnx` + `.onnx.data` (e.g. reliquary-biglama) — onnxruntime-web needs the `.data` fetched separately and passed via `externalData`, which is more complex.
- **Pin versions**: fix a commit hash — `/resolve/<commit>/<file>` (current repo commit `418036c6`) — so upstream changes can't break the build.
- **Mirror for production**: move the files to your own R2/CDN before launch (control CORS/CORP headers and caching, pin versions, don't depend on a third party's availability).
- **Regional reach**: hf.co can be unstable in some regions (e.g. mainland China); deployments serving those users must mirror to reachable storage/CDN.
- **License**: LaMa weights and these exports are Apache-2.0 — usable commercially with attribution.

**Alternative: export yourself** (only if you need a custom tier / quantization strategy, or the upstream source is unavailable):

1. Load the LaMa pretrained weights in PyTorch and export with `torch.onnx.export` (fixed input size, `dynamic_axes` off, for simpler deployment).
2. Simplify with `onnxsim` (graph simplification, constant folding).
3. Optionally produce smaller tiers (lite/balanced). **Use weight-only compression** (quantize only the 222 Conv weight tensors; inference still runs in fp32; use per-channel asymmetric UINT8 for int8). ⚠️ Naive full-graph fp16/int8 conversion corrupts the model: LaMa's BatchNorm `running_var` values reach ~480,000, beyond fp16 max (65504); truncating them breaks normalization. Reference outputs: fp32 209MB / fp16 110MB / int8 61.5MB.
4. Upload to R2 / CDN and register the URL and `sizeMB` in the registry.

### 6.3 Caching (Cache API)

- First use of a tier downloads it; on completion, store it in the **Cache API** (key = model URL).
- Later uses check the Cache first: a hit reads `cache.match(url)` directly, **no re-download**.
- Cache keys are versioned (`INPAINT_MODELS_V1`); bump the version when the registry changes to invalidate old entries.
- "Delete model" calls `cache.delete(url)` to free space.
- **Re-download**: cached models offer a "re-download" action (delete from cache, then re-fetch per §6.4) for corrupted files or upstream updates.
- **Cache list = model list**: the panel enumerates the cache by URL; built-ins and user models are shown together; cached entries are marked "cached" and switchable to current in one click.
- **Local uploads**: bytes live in IndexedDB (`origin: 'upload'`, no URL so the Cache API doesn't apply); deleting the model also clears the IndexedDB entry. The Worker loads either source through one branch: Cache/fetch for URLs, IndexedDB for uploads.
- **Persistence protection**: call `navigator.storage.persist()` at startup to reduce the chance of the browser evicting the cache under storage pressure; show model cache usage via `navigator.storage.estimate()` in a "storage" panel.
- **Safari**: Safari has historically had Cache API quota/stability issues; on Cache write failure, **fall back to IndexedDB** (model bytes + version).
- Fallback: if a cache lookup fails or the response is corrupt, re-download from the network.
- **Offline**: once a model is cached, the UI, engine, and model are all local — the whole erase flow works **fully offline**.

### 6.4 Download Progress

After `fetch`, read `content-length` and stream the body, counting bytes and reporting progress; hand the streaming response straight to `cache.put`:

```ts
async function downloadWithProgress(
  url: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<Response> {
  const res = await fetch(url);
  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = res.body!.getReader();
  let loaded = 0;
  // Stream through: never accumulate the whole model in JS memory
  // (avoids a ~200MB peak); cache.put consumes this stream, we only count bytes.
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      loaded += value.byteLength;
      onProgress(loaded, total);
      controller.enqueue(value);
    },
    cancel() { return reader.cancel(); },
  });
  return new Response(stream, { status: 200, headers: res.headers });
}
```

- **Prompt before download**: on click, show a confirmation (i18n) with source, size, and network requirement: "Download the {name} model ({size} MB) from {source}. Make sure your network is available." `{source}` is the host of the model URL (e.g. `huggingface.co`) or your CDN domain, derived from the registry — so users aren't confused when it looks stuck or fails offline.
- UI: progress bar + `downloaded / total` (MB) + percentage; cancel via AbortController.
- Failure handling: distinguish causes (offline / storage quota / source unreachable) and offer retry; `navigator.onLine` can pre-check and show "network unavailable" (cached models are unaffected and still work offline).
- No resumable downloads (models are one-shot downloads; not worth the complexity), but retry is allowed after an interruption.

---

### 6.5 Capability Detection & Model Recommendation

The model panel runs a capability check once at startup (`src/config/detect.ts`), **auto-recommends** a tier, and **explains why** when a tier is incompatible or will feel slow:

| Signal | How | Effect on recommendation |
| --- | --- | --- |
| WebGPU | `navigator.gpu` exists | Available → recommend balanced (fp16 fixed-512 runs fully on GPU, ~5× faster); WASM only → recommend lite (int8 ~1.8× faster on CPU/WASM) |
| Cross-origin isolation | `crossOriginIsolated` | Missing → single-threaded inference, slower; suggest lite with a hint |
| Device memory | `navigator.deviceMemory` (Chromium) | ≤ 4GB → recommend lite (lowest peak memory) |
| Mobile | UA + `(pointer: coarse)` | Default to lite (512-input fp16 can peak at hundreds of MB) |
| Storage quota | `navigator.storage.estimate()` | Free space < model size → warn "not enough storage to download this tier (needs {size} MB)" |
| Network | `navigator.onLine` + `connection.effectiveType` / `saveData` | Offline & not cached → tier not selectable; 2G / saveData → warn about data usage |

Presentation:

- The recommended tier gets a **"Recommended" badge**; when several signals apply, the highest-priority one wins (WebGPU > memory > mobile > threads).
- Non-recommended tiers show a reason next to them (e.g. "slow without WebGPU", "lite suggested on low-memory devices").
- Edge cases: no WASM (very old browsers) → show "your browser does not support inference" and disable the erase entry; missing cross-origin isolation **does not block usage**, it only warns about performance.
- The recommendation is a default only — the user can always override.

### 6.6 Runtime loading, threading & EP selection (production lessons)

- **Entry point matters**. ORT ≥ 1.19's default entry dynamically imports the jsep variant (`ort-wasm-simd-threaded.jsep.mjs`, ~27MB). Use `onnxruntime-web/wasm` for a wasm-only build, or `onnxruntime-web/webgpu` to get both WebGPU and WASM providers (the webgpu entry references `ort-wasm-simd-threaded.asyncify.*`). Because which glue the runtime picks is version-dependent, **copy every `ort-wasm-*` file** into `/ort/` (see §12.2).
- **`graphOptimizationLevel: 'all'` can stall session creation for minutes** on a multi-hundred-MB model under WASM; `'disabled'` parses a 100MB model in ~0.5s with negligible runtime loss for an already-exported model. Do not enable the optimizer for these one-shot pipelines.
- **ORT-internal pthreads dead-lock in the dev server**. `numThreads > 1` makes ORT spawn `new Worker(glueUrl, {type:'module'})` thread workers; in the Vite dev server this silently hangs `createSession` (reproduced on both wasm and webgpu providers). Fix: run `threads = 1` and get multi-core from tile-level concurrency on the main thread (desktop 4, mobile 2). Guard session init with a hard timeout (~120s) that terminates the worker and lets the user retry.
- **WebGPU EP**: when `'gpu' in navigator`, use `executionProviders: ['webgpu', 'wasm']` (per-op fallback to wasm). Measured on an M1-class device: ~30× faster per tile (0.4s vs 12.5s for a 512² fp16 tile). The WebGPU queue is serial, so cap tile concurrency at 1 on GPU devices. The output tensor may come back as **float16** — convert to float32 before paste-back.
- **Diagnosability**: worker init and per-tile inference should log timings (DevTools console) and the progress bar should show the current stage with elapsed seconds; hangs were repeatedly misdiagnosed as slowness until stage logs showed exactly where execution stopped.

---

## 7. Mask Editing

- The mask is stored as a **`Uint8ClampedArray` (1 byte/pixel)** at the image's original resolution for exact drawing; it is converted to `ImageData` (RGBA) only for drawing/display. A 4000×3000 mask drops from 48MB (RGBA) to 12MB.
- Brushes draw via `pointerdown / pointermove / pointerup` (Pointer Events cover mouse and touch natively — no extra mobile work).
- Undo/redo: a mask snapshot stack (cap ~30 entries). Each snapshot **stores only the modified bbox region** (or RLE), avoiding full-image copies that would blow up memory.
- The main canvas renders at devicePixelRatio-aware DPI; export re-renders at original resolution.

---

## 8. State Management

A small custom store — `createStore<T>(reducer, initialState)` with `getState()` / `dispatch(action)` / `subscribe(listener)` — views subscribe to slices on demand.

```ts
interface AppState {
  image: { bitmap: ImageBitmap; width: number; height: number } | null;
  mask: Uint8ClampedArray | null;       // same size as image, 1B/px
  maskHistory: { undo: MaskSnapshot[]; redo: MaskSnapshot[] };  // MaskSnapshot = modified bbox rect + pixels
  result: ImageData | null;             // full-size result buffer: copy of original, tiles pasted in as they finish
  inference: { status: 'idle'|'running'|'done'|'error'; done: number; total: number };
  model: {
    selected: ModelSpec | null;                                 // current model (panel display + inference)
    builtin: ModelSpec[];                                       // built-in registry
    custom: ModelSpec[];                                        // user-added models (metadata in localStorage)
    cacheStatus: Record<string, 'none' | 'downloading' | 'cached'>;  // key: model id/URL (id for uploads)
  };
  settings: { lang: string; theme: 'light'|'dark'|'system' };
}
```

---

## 9. i18n

- Small custom module (~100 lines), no dependencies.
- Locales: `src/i18n/locales/{en,zh-CN,...}.ts`, type-safe `Record<Lang, Messages>` with `en` as the base type — missing keys fail at compile time.

```ts
// locales/en.ts (example)
export const en = {
  'app.title': 'inpaint',
  'action.upload': 'Upload Image',
  'action.erase': 'Erase',
  'model.balanced.name': 'Balanced',
  'model.download.prompt': 'This will download the {name} model ({size} MB) from {source}. Please make sure your network is available.',
  'model.download.offline': 'Network unavailable — the model cannot be downloaded (cached models still work offline).',
  // …
} as const;
```

- Detection: exact `navigator.language` match → parent language family fallback (`zh-TW` → `zh`) → the family's default pack (`zh` defaults to `zh-CN`) → fall back to `en` (unlisted languages see English).
- A manual choice is persisted to `localStorage` and takes priority on next launch.
- Switching updates `document.documentElement.lang` and all `data-i18n` nodes; `{var}` interpolation is supported.
- Adding a language = add one locale file and register it.

---

## 10. Theming (Light / Dark)

- All colors live in **CSS custom properties (design tokens)** — `--color-bg`, `--color-surface`, `--color-text`, `--color-accent`, etc.
- `data-theme="light|dark"` is set on `<html>`:
  - `system`: reads `prefers-color-scheme` and follows `matchMedia` changes automatically;
  - manual: overrides to a fixed value, persisted to `localStorage`.
- Canvas colors (mask/brush) are content-semantic and not affected by the theme.
- Switching costs nothing: only tokens change; component styles are theme-agnostic.

---

## 11. Responsive & Mobile

- **Breakpoint**: `< 768px` mobile layout, `≥ 768px` desktop (plus `(pointer: coarse)` for touch-specific details).
- **Layout**:
  - Single centered column on every screen: topbar + full-bleed canvas workspace.
  - Desktop: floating bars — step indicator top-center, batch strip below it, paint/erase control bars bottom-center, result actions bottom-right, progress bar above the control bars.
  - Mobile: the same floating bars re-flow to full-width bottom sheets; the step indicator collapses to numbered dots; paint controls stack; safe-area insets are respected.
- **Interaction**: Pointer Events everywhere; double-tap to zoom, pinch to zoom on touch (with CSS `touch-action`); touch targets ≥ 44×44px.
- The view layer swaps two style sets by viewport; core logic (tiling, inference, storage) is device-agnostic with no branching.

---

## 12. Deployment (Cloudflare)

### 12.1 Build & publish

- `vite build` produces a pure static directory (`dist/`).
- Option A (recommended): **Cloudflare Workers Static Assets** — static assets mounted on the Worker route, with response-header logic.
- Option B: Cloudflare Pages, `build_command: vite build`, `output: dist`.

### 12.2 Key response headers

onnxruntime-web multi-threading needs `SharedArrayBuffer`, which requires cross-origin isolation:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- Pages: declare via the `_headers` file; Workers: inject in the Worker response.
- **COEP is a global constraint**: under `require-corp`, **every** cross-origin subresource (fonts, icons, any third-party script) must carry CORS or CORP headers, or the whole page fails to load. Inventory all third-party resources before launch, or self-host them same-origin.
- **The ORT runtime must be local**: put **every** `ort-wasm-*` file (jsep/jspi/asyncify/simd-threaded `.mjs` + `.wasm`) in `public/ort/` and set `ort.env.wasm.wasmPaths = '/ort/'`. Which glue variant loads depends on the ORT version and the imported entry (`onnxruntime-web/wasm` → simd-threaded, `onnxruntime-web/webgpu` → asyncify); copying all of them makes `/ort/` self-sufficient. Depending on a CDN default path (e.g. jsdelivr) is blocked outright by the browser under COEP.
- **Same headers in dev**: the Vite dev server must also inject COOP/COEP (a small plugin/middleware), otherwise threading problems only surface after deploy.
- **Dev-only gotcha**: ORT loads its glue via `import('/ort/….mjs')`, which the Vite dev server treats as a module transform and refuses for files in `/public` ("should not be imported from source code"). Add a dev middleware **ahead of Vite's pipeline** that serves `/ort/*` as plain static files (`.mjs` → `text/javascript`, `.wasm` → `application/wasm`) — mirroring production static hosting.
- **Why models can't be same-origin**: Workers Static Assets and Pages both cap individual files at **25 MiB** — models (62–209MB) don't fit, so they must live on R2/CDN with CORS (`Access-Control-Allow-Origin: *`) + CORP (`Cross-Origin-Resource-Policy: cross-origin`).
- Other security headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Content-Security-Policy` (e.g. `worker-src 'self' blob:`).
- Static assets: long cache (`Cache-Control: immutable`, hashed file names); `index.html`: short cache (`no-cache`).
- Model files: long cache on the R2/CDN side.

### 12.3 Degradation

If cross-origin isolation isn't available (e.g. embedded WebViews), fall back to single-threaded inference (`threads=1`, and recover from SIMD errors by disabling it). The app still works, just slower — with a UI hint.

---

## 13. Performance

| Area | Measures |
| --- | --- |
| Inference | WASM SIMD + tile-level parallelism, concurrency capped per device (mobile 2, desktop 4); **WebGPU EP when `navigator.gpu` exists** (`['webgpu','wasm']` providers, ~30× faster, serial queue → tile concurrency 1); ORT-internal threading left at 1 (pthread dead-lock guard, §6.6) |
| Memory | Mask at 1B/px (§7); full-size result buffer kept resident for progressive preview; intermediate tensors freed immediately; large arrays transferred via `Transferable` |
| Models | Multiple tiers (int8/fp16/fp32); mobile defaults to lite (int8), desktop to balanced; less download and less time |
| Startup | Model code and the Worker are lazy-loaded (`import()` + dynamic Worker creation); first paint only loads the UI shell |
| Large images | Decode to a display thumbnail for canvas interaction first; inference tiles at original resolution only |
| Bundle | No framework; Vite code-splits; onnxruntime-wasm served from `public/ort/` (no external CDN under COEP); inference assets never load on first paint |
| Mobile | 512-input fp16 inference can peak at hundreds of MB — low-memory iOS devices risk being killed by the OS; mobile defaults to **int8/lite** (~62MB, ~1.8× faster on CPU/WASM); fp16/fp32 only on desktop or after explicit user confirmation |
| Time expectations | Measured reference (M1-class, 512² tile): **WASM single-threaded fp16 ≈ 12.5s/tile, WebGPU ≈ 0.4s/tile (~30×)**; model parse with optimization disabled ≈ 0.5s for a 100MB model. Full images: WASM ~10–30s for 2K, ~30–90s for 4K; WebGPU drops both by ~an order of magnitude. Show tile-level progress with per-tile average and keep the page in the foreground (mobile JS is suspended in background / on lock screen) |

---

## 14. Directory Structure

```
inpaint/
├── public/
│   └── ort/                 # onnxruntime-wasm runtime files (.wasm/.mjs)
├── src/
│   ├── main.ts              # entry: wires up UI, store, worker
│   ├── core/
│   │   ├── image.ts         # image decode/encode/resize/bitmap helpers
│   │   ├── mask.ts          # mask model + drawing snapshot stack
│   │   ├── tiler.ts         # tiling / padding / feather blending (pure)
│   │   └── inpaint.ts       # erase pipeline orchestration (main thread)
│   ├── wasm/
│   │   ├── session.ts       # ort session creation + tensor helpers
│   │   └── worker.ts        # inference Worker (entry + message protocol)
│   ├── storage/
│   │   ├── modelCache.ts    # Cache API + progress download
│   │   └── settings.ts      # localStorage settings read/write
│   ├── ui/
│   │   ├── canvas/          # canvas component (brush, zoom, before/after)
│   │   ├── components/      # model panel/dialog, progress bar, step bars
│   │   └── theme.ts         # theme system
│   ├── i18n/
│   │   ├── index.ts
│   │   └── locales/{en,zh-CN}.ts
│   ├── config/
│   │   ├── models.ts        # model registry
│   │   ├── detect.ts        # capability detection & tier recommendation (§6.5)
│   │   └── constants.ts     # breakpoints, brush & tiling defaults
│   └── styles/              # design tokens (light/dark), layout
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── design.md
```

---

## 15. Out of Scope

- No server-side inference / cloud processing (by design, images never leave the browser).
- No other image editing (crop, filters, color) — focused on erase only.
- No login, accounts, cloud storage, or collaboration.
- No resumable model downloads (retry and cancel are kept).

---

## 16. Milestones

| Phase | Scope | Acceptance |
| --- | --- | --- |
| M1 Skeleton | Vite+TS project, design tokens, i18n framework, theme switching, responsive shell | Shell deploys to Cloudflare; en/zh switching, light/dark, mobile layout all work |
| M2 Editing | Image import, brush/eraser, undo/redo, before/after & export | Mask drawing and export work on desktop + touch |
| M3 Inference | Model registry, progress download & cache, Worker inference, tiled blending | Small/medium images (<512px) erase with acceptable quality; second launch does not re-download |
| M4 High resolution | Large-image tiled parallelism, feather blending, cancel/retry | 4000×3000-class images erase with no visible seams |
| M5 Polish | Performance tuning, degradation paths, error messaging, i18n completion, optional PWA | Stable end-to-end flow verified on Safari/Chrome/Firefox and mobile |
