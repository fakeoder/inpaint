/**
 * Model registry (design §6.1).
 *
 * Model files are NOT bundled; this module maps model IDs to remote URLs
 * (community-packaged LaMa ONNX exports from g-ronimo/lama). They are
 * fetched on demand and cached (design §6.3).
 */

export interface ModelSpec {
  id: string; // 'lite'|'balanced'|'quality' for built-ins; derived from URL/file name for custom
  kind: 'builtin' | 'custom';
  origin?: 'url' | 'upload'; // custom models only
  nameKey?: string; // i18n key for built-ins; custom models use `name`
  name?: string; // custom model name shown in the UI
  url?: string; // model file URL; empty for local uploads
  inputSize: number; // model input edge in px (32-aligned baseline)
  sizeMB: number; // approximate size for display
  threads: number; // recommended inference threads
  noteKey?: string; // i18n key for built-ins (quality/speed note)
  /** true when the model requires exactly inputSize×inputSize feeds (design §6.1). */
  fixedInput?: boolean;
}

const HF = 'https://huggingface.co/g-ronimo/lama/resolve/418036c6/';

export const MODEL_REGISTRY: ModelSpec[] = [
  {
    id: 'lite',
    kind: 'builtin',
    url: `${HF}lama_512_int8.onnx`,
    nameKey: 'model.lite.name',
    noteKey: 'model.lite.note',
    inputSize: 512,
    sizeMB: 62,
    threads: 2,
    fixedInput: true,
  },
  {
    id: 'balanced',
    kind: 'builtin',
    url: `${HF}lama_512_fp16.onnx`,
    nameKey: 'model.balanced.name',
    noteKey: 'model.balanced.note',
    inputSize: 512,
    sizeMB: 107,
    threads: 4,
    fixedInput: true,
  },
  {
    id: 'quality',
    kind: 'builtin',
    url: `${HF}lama.onnx`,
    nameKey: 'model.quality.name',
    noteKey: 'model.quality.note',
    inputSize: 512,
    sizeMB: 209,
    threads: 4,
    fixedInput: false,
  },
];

/** Model display name (i18n for built-ins, `name` for custom). */
export function modelName(spec: ModelSpec, translate: (key: Parameters<typeof import('../i18n').t>[0]) => string): string {
  if (spec.name) return spec.name;
  if (spec.nameKey) return translate(spec.nameKey as never);
  return spec.id;
}
