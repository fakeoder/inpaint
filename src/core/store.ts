/**
 * Small custom store (design §8): createStore with immutable snapshots +
 * subscribe. No third-party dependencies.
 */
import { MaskHistory } from './mask';
import type { ModelSpec } from '../config/models';

/** One image in a batch; all share the same dimensions (fixed-position mask). */
export interface BatchImage {
  id: string;
  name: string;
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export interface AppState {
  image: { bitmap: ImageBitmap; width: number; height: number } | null;
  mask: Uint8ClampedArray | null;
  maskWidth: number;
  maskHeight: number;
  maskHistory: MaskHistory;
  /** Full-size result buffer: copy of original, tiles pasted in as they finish. */
  result: ImageData | null;
  inference: {
    status: 'idle' | 'running' | 'done' | 'error';
    done: number;
    total: number;
    message?: string;
  };
  model: {
    selected: ModelSpec | null;
    builtin: ModelSpec[];
    custom: ModelSpec[];
    /** key: model id (built-ins) or URL (custom url) — see §6.1 */
    cacheStatus: Record<string, 'none' | 'downloading' | 'cached'>;
  };
  /** Multi-image batch: all images share one fixed-position mask (design §2.6). */
  batch: {
    images: BatchImage[];
    index: number;
    results: (ImageData | null)[];
  };
}

export const initialState: AppState = {
  image: null,
  mask: null,
  maskWidth: 0,
  maskHeight: 0,
  maskHistory: new MaskHistory(),
  result: null,
  inference: { status: 'idle', done: 0, total: 0 },
  model: {
    selected: null,
    builtin: [],
    custom: [],
    cacheStatus: {},
  },
  batch: { images: [], index: 0, results: [] },
};

export type Action =
  | { type: 'IMAGE_LOADED'; bitmap: ImageBitmap; width: number; height: number }
  | { type: 'MASK_INIT'; mask: Uint8ClampedArray; width: number; height: number }
  | { type: 'MASK_CHANGED' } // mask mutated in place (stroke/undo/redo/clear)
  | { type: 'MASK_CLEARED' }
  | { type: 'RESULT_SET'; result: ImageData | null }
  | { type: 'INFERENCE_STATUS'; status: AppState['inference']['status']; done?: number; total?: number; message?: string }
  | { type: 'MODELS_SET'; builtin: ModelSpec[]; custom: ModelSpec[] }
  | { type: 'MODEL_SELECTED'; spec: ModelSpec | null }
  | { type: 'MODEL_CACHE_STATUS'; id: string; status: 'none' | 'downloading' | 'cached' }
  | { type: 'BATCH_SET'; images: BatchImage[] }
  | { type: 'BATCH_SELECT'; index: number }
  | { type: 'BATCH_RESULT_SET'; index: number; result: ImageData | null };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'IMAGE_LOADED':
      return {
        ...state,
        image: { bitmap: action.bitmap, width: action.width, height: action.height },
        result: null,
        inference: { status: 'idle', done: 0, total: 0 },
      };
    case 'MASK_INIT':
      return {
        ...state,
        mask: action.mask,
        maskWidth: action.width,
        maskHeight: action.height,
        maskHistory: new MaskHistory(),
      };
    case 'MASK_CHANGED':
      return { ...state };
    case 'MASK_CLEARED':
      if (!state.mask) return state;
      state.mask.fill(0);
      state.maskHistory.clear();
      return { ...state, result: null };
    case 'RESULT_SET':
      return { ...state, result: action.result };
    case 'INFERENCE_STATUS':
      return {
        ...state,
        inference: {
          status: action.status,
          done: action.done ?? state.inference.done,
          total: action.total ?? state.inference.total,
          message: action.message ?? state.inference.message,
        },
      };
    case 'MODELS_SET':
      return { ...state, model: { ...state.model, builtin: action.builtin, custom: action.custom } };
    case 'MODEL_SELECTED':
      return { ...state, model: { ...state.model, selected: action.spec } };
    case 'MODEL_CACHE_STATUS':
      return {
        ...state,
        model: {
          ...state.model,
          cacheStatus: { ...state.model.cacheStatus, [action.id]: action.status },
        },
      };
    case 'BATCH_SET': {
      const first = action.images[0];
      return {
        ...state,
        image: first ? { bitmap: first.bitmap, width: first.width, height: first.height } : null,
        result: null,
        inference: { status: 'idle', done: 0, total: 0 },
        batch: { images: action.images, index: 0, results: action.images.map(() => null) },
      };
    }
    case 'BATCH_SELECT': {
      const img = state.batch.images[action.index];
      if (!img || action.index === state.batch.index) return state;
      return {
        ...state,
        image: { bitmap: img.bitmap, width: img.width, height: img.height },
        result: state.batch.results[action.index] ?? null,
        batch: { ...state.batch, index: action.index },
      };
    }
    case 'BATCH_RESULT_SET': {
      if (!state.batch.images[action.index]) return state;
      const results = [...state.batch.results];
      results[action.index] = action.result;
      return {
        ...state,
        result: action.index === state.batch.index ? action.result : state.result,
        batch: { ...state.batch, results },
      };
    }
    default:
      return state;
  }
}

export interface Store<S, A> {
  getState(): S;
  dispatch(action: A): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S, A>(reducerFn: (state: S, action: A) => S, initial: S): Store<S, A> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action: A): void {
      state = reducerFn(state, action);
      for (const l of listeners) l();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
