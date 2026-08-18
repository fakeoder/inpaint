/** App-wide constants: brush defaults, tiling defaults. */

/** Cap on the longest image side in px; beyond this we refuse to import (design §2.1). */
export const MAX_IMAGE_SIDE = 8000;

/** Undo/redo mask snapshot cap (design §7). */
export const MASK_HISTORY_LIMIT = 30;

/** Default brush settings. */
export const BRUSH_DEFAULTS = {
  size: 40,
  hardness: 1, // 1 = hard edge, 0 = fully soft
} as const;

/** Tiling defaults (design §5.2) — tuned against the LaMa 512 model. */
export const TILING_DEFAULTS = {
  /** Extra context around the mask bbox. */
  padding: 128,
  /** Extra context fed around each tile; larger = fewer seams, more compute. */
  overlap: 64,
  /** Tile offsets/steps must stay aligned to this (LaMa requires H/W % 32 == 0). */
  align: 32,
  /** Max concurrent tiles (design §13: desktop 4, mobile 2). */
  concurrency: 4,
  mobileConcurrency: 2,
} as const;

/** Cached model store version — bump to invalidate old cache entries (design §6.3). */
export const MODEL_CACHE_VERSION = 'INPAINT_MODELS_V1';

/** Hard cap on Worker session initialization (model parse + wasm bring-up). */
export const MODEL_INIT_TIMEOUT_MS = 120_000;

/** IndexedDB database name for uploaded models and Cache-API fallback. */
export const IDB_NAME = 'inpaint';
export const IDB_MODEL_STORE = 'models';
