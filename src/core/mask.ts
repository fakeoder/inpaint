/**
 * Mask model (design §7).
 *
 * The mask is a Uint8ClampedArray at 1 byte/pixel, same size as the image —
 * a 4000×3000 mask is 12MB instead of 48MB as RGBA. It is converted to
 * ImageData (RGBA) only for display.
 *
 * Undo/redo stores only the modified bbox region per stroke, avoiding
 * full-image copies (mask history cap ~30 entries).
 */
import { MASK_HISTORY_LIMIT } from '../config/constants';

export type MaskMode = 'add' | 'erase';

export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A snapshot stores only the pixels inside its bbox, not the whole mask. */
export interface MaskSnapshot {
  rect: MaskRect;
  pixels: Uint8ClampedArray; // rect.w * rect.h bytes
}

export interface BrushState {
  size: number; // diameter in px
  hardness: number; // 0..1
}

export interface StrokePoint {
  x: number;
  y: number;
}

export function createMask(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height);
}

/** Bounding box of all painted (non-zero) pixels; null when the mask is empty. */
export function maskBBox(mask: Uint8ClampedArray, width: number, height: number): MaskRect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Coverage (0..255) of a soft/hard round brush at a pixel offset from its center. */
function brushAlpha(dist: number, radius: number, hardness: number): number {
  if (hardness >= 1) return dist <= radius ? 255 : 0;
  // soft falloff zone between inner hard core and outer edge
  const soft = Math.max(radius * (1 - hardness), 0.5);
  const inner = Math.max(radius - soft, 0);
  if (dist <= inner) return 255;
  if (dist >= radius) return 0;
  const t = (dist - inner) / (radius - inner || 1);
  return Math.round(255 * (1 - t) * (1 - t)); // smooth quadratic falloff
}

/**
 * Bounding box (in image pixels) of a stroke: union of all brush stamps
 * along the interpolated path, expanded by the brush radius.
 */
export function strokeBBox(points: StrokePoint[], brush: BrushState, width: number, height: number): MaskRect {
  const radius = brush.size / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  if (points.length === 1) {
    const p = points[0]!;
    minX = p.x - radius;
    minY = p.y - radius;
    maxX = p.x + radius;
    maxY = p.y + radius;
  } else {
    const step = Math.max(1, Math.floor(brush.size * 0.35));
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(dist / step));
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        if (x - radius < minX) minX = x - radius;
        if (y - radius < minY) minY = y - radius;
        if (x + radius > maxX) maxX = x + radius;
        if (y + radius > maxY) maxY = y + radius;
      }
    }
  }
  const x = Math.max(0, Math.floor(minX));
  const y = Math.max(0, Math.floor(minY));
  const x2 = Math.min(width - 1, Math.ceil(maxX));
  const y2 = Math.min(height - 1, Math.ceil(maxY));
  return { x, y, w: Math.max(1, x2 - x + 1), h: Math.max(1, y2 - y + 1) };
}

/** Copy the pixels of `rect` out of a full mask (needs the real mask width). */
export function snapshotAt(mask: Uint8ClampedArray, width: number, rect: MaskRect): MaskSnapshot {
  const pixels = new Uint8ClampedArray(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) {
    const srcStart = (rect.y + y) * width + rect.x;
    const dstStart = y * rect.w;
    pixels.set(mask.subarray(srcStart, srcStart + rect.w), dstStart);
  }
  return { rect, pixels };
}

/** Write a snapshot's pixels back into a full mask. */
export function restoreRegion(mask: Uint8ClampedArray, width: number, snap: MaskSnapshot): void {
  const { rect, pixels } = snap;
  for (let y = 0; y < rect.h; y++) {
    const srcStart = y * rect.w;
    const dstStart = (rect.y + y) * width + rect.x;
    mask.set(pixels.subarray(srcStart, srcStart + rect.w), dstStart);
  }
}

/**
 * Stamp a round brush at (cx, cy) into the mask.
 */
export function stampCircle(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  brush: BrushState,
  mode: MaskMode,
): void {
  const radius = brush.size / 2;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  const r2 = radius * radius;

  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > r2) continue;
      const alpha = brushAlpha(Math.sqrt(dist2), radius, brush.hardness);
      if (alpha === 0) continue;
      const idx = y * width + x;
      const cur = mask[idx]!;
      const next = mode === 'add' ? Math.max(cur, alpha) : Math.min(cur, 255 - alpha);
      if (next !== cur) mask[idx] = next;
    }
  }
}

/** Fixed alpha (0..255) used to draw the mask overlay. Painting is a
 *  SELECTION, not a graded brush: any painted pixel (value > 0) renders at
 *  this single alpha, so overlapping strokes never stack darker. The model
 *  input is binarized the same way in `sampleContext` (design §5.1/§6.1). */
export const MASK_DISPLAY_ALPHA = 128;

/**
 * Compose the display RGBA mask layer for `rect` from the committed mask
 * plus an optional in-progress stroke layer. Pixels are binary (painted or
 * not) — both the committed mask and the stroke are thresholded at >0, then:
 *   add:   v = mask || stroke
 *   erase: v = mask && !stroke
 * Only the red+alpha channels are written (green/blue stay 0).
 */
export function composeMaskRegion(
  out: ImageData,
  mask: Uint8ClampedArray,
  stroke: Uint8ClampedArray | null,
  rect: MaskRect,
  mode: MaskMode,
): void {
  const { x, y, w, h } = rect;
  for (let row = 0; row < h; row++) {
    const mi = (y + row) * out.width + x;
    const oi = mi * 4;
    for (let col = 0; col < w; col++) {
      let v = mask[mi + col]! > 0 ? 1 : 0;
      if (stroke) {
        const s = stroke[mi + col]! > 0 ? 1 : 0;
        v = mode === 'add' ? v | s : s ? 0 : v;
      }
      out.data[oi + col * 4] = 255;
      out.data[oi + col * 4 + 3] = v ? MASK_DISPLAY_ALPHA : 0;
    }
  }
}

/* ── Snapshot stack (undo/redo) ─────────────────────────────── */

export class MaskHistory {
  private undoStack: MaskSnapshot[] = [];
  private redoStack: MaskSnapshot[] = [];

  /** Push a snapshot taken BEFORE painting over `rect`. */
  push(snap: MaskSnapshot): void {
    this.undoStack.push(snap);
    if (this.undoStack.length > MASK_HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Restore the most recent snapshot, capturing the current (post-stroke)
   * state so redo can restore it. Returns the affected rect.
   */
  undo(mask: Uint8ClampedArray, width: number): MaskRect | null {
    const snap = this.undoStack.pop();
    if (!snap) return null;
    const after = snapshotAt(mask, width, snap.rect);
    restoreRegion(mask, width, snap);
    this.redoStack.push(after);
    return snap.rect;
  }

  redo(mask: Uint8ClampedArray, width: number): MaskRect | null {
    const snap = this.redoStack.pop();
    if (!snap) return null;
    const after = snapshotAt(mask, width, snap.rect);
    restoreRegion(mask, width, snap);
    this.undoStack.push(after);
    return snap.rect;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
