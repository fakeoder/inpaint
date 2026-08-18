import { describe, expect, it } from 'vitest';
import {
  createMask,
  maskBBox,
  snapshotAt,
  restoreRegion,
  MaskHistory,
  composeMaskRegion,
  MASK_DISPLAY_ALPHA,
  strokeBBox,
  type BrushState,
} from '../src/core/mask';

const brush: BrushState = { size: 20, hardness: 1 };

describe('mask: bbox & snapshots', () => {
  it('maskBBox returns null for an empty mask', () => {
    expect(maskBBox(createMask(10, 10), 10, 10)).toBeNull();
  });

  it('maskBBox wraps painted pixels', () => {
    const m = createMask(100, 100);
    m[5 * 100 + 20] = 255;
    m[9 * 100 + 30] = 128;
    expect(maskBBox(m, 100, 100)).toEqual({ x: 20, y: 5, w: 11, h: 5 });
  });

  it('snapshot/restore round-trips a region', () => {
    const m = createMask(50, 50);
    for (let i = 0; i < m.length; i++) m[i] = i % 256;
    const rect = { x: 10, y: 5, w: 20, h: 15 };
    const snap = snapshotAt(m, 50, rect);
    // mutate the region
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) m[y * 50 + x] = 0;
    }
    restoreRegion(m, 50, snap);
    for (let i = 0; i < m.length; i++) {
      expect(m[i]).toBe(i % 256);
    }
  });

  it('history undo/redo restores pre-stroke state', () => {
    const m = createMask(64, 64);
    const hist = new MaskHistory();
    const bbox = strokeBBox([{ x: 32, y: 32 }], brush, 64, 64);
    hist.push(snapshotAt(m, 64, bbox));
    m[32 * 64 + 32] = 255;
    expect(m[32 * 64 + 32]).toBe(255);
    expect(hist.undo(m, 64)).not.toBeNull();
    expect(m[32 * 64 + 32]).toBe(0);
    expect(hist.redo(m, 64)).not.toBeNull();
    expect(m[32 * 64 + 32]).toBe(255);
  });
});

describe('mask: display compose', () => {
  it('composes add-mode stroke into the display layer', () => {
    const img = new ImageData(10, 10);
    const mask = createMask(10, 10);
    const stroke = createMask(10, 10);
    stroke[3 * 10 + 4] = 200;
    composeMaskRegion(img, mask, stroke, { x: 0, y: 0, w: 10, h: 10 }, 'add');
    expect(img.data[(3 * 10 + 4) * 4]).toBe(255); // red
    expect(img.data[(3 * 10 + 4) * 4 + 3]).toBe(MASK_DISPLAY_ALPHA); // binary, fixed alpha
  });

  it('composes erase-mode stroke by clearing the pixel', () => {
    const img = new ImageData(10, 10);
    const mask = createMask(10, 10).fill(255) as Uint8ClampedArray;
    const stroke = createMask(10, 10);
    stroke[1 * 10 + 1] = 100;
    composeMaskRegion(img, mask, stroke, { x: 0, y: 0, w: 10, h: 10 }, 'erase');
    expect(img.data[(1 * 10 + 1) * 4 + 3]).toBe(0);
  });
});
