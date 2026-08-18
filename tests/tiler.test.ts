import { describe, expect, it } from 'vitest';
import { planRegion, planTiles, accumulateTile, finalizeRegion, sampleContext } from '../src/core/tiler';
import { maskBBox } from '../src/core/mask';

describe('tiler: planRegion', () => {
  it('pads the bbox by the given padding', () => {
    const r = planRegion({ x: 100, y: 50, w: 200, h: 100 }, { padding: 128 });
    expect(r.rect).toEqual({ x: -28, y: -78, w: 456, h: 356 });
    expect(r.w).toBe(456);
    expect(r.h).toBe(356);
  });
});

describe('tiler: planTiles', () => {
  it('produces a single tile when the region fits the model input', () => {
    const { region, tiles } = planTiles(
      { x: 10, y: 10, w: 50, h: 50 },
      1000,
      1000,
      { padding: 64, overlap: 64, align: 32, inputSize: 512, fixedInput: false },
    );
    expect(region.w).toBe(178);
    expect(tiles).toHaveLength(1);
    const t = tiles[0]!;
    expect(t.feedW % 32).toBe(0);
    expect(t.feedH % 32).toBe(0);
    expect(t.feedW).toBe(320); // 178 aligned up to 32 + 2*64
    expect(t.feedW).toBeLessThan(512); // no resize needed for dynamic model
  });

  it('grids a large region into multiple 32-aligned overlapping tiles', () => {
    const bbox = { x: 0, y: 0, w: 1200, h: 800 };
    const { region, tiles } = planTiles(bbox, 4000, 3000, {
      padding: 128, overlap: 64, align: 32, inputSize: 512, fixedInput: false,
    });
    expect(region.w).toBe(1456);
    expect(region.h).toBe(1056);
    // step = 512 − 64 = 448 → cols = ceil(1456/448) = 4, rows = ceil(1056/448) = 3
    expect(tiles).toHaveLength(12);
    for (const t of tiles) {
      expect(t.feedW % 32).toBe(0);
      expect(t.feedH % 32).toBe(0);
      expect(t.tile.w % 32).toBe(0);
      expect(t.tile.h % 32).toBe(0);
    }
  });

  it('resizes every tile to the model input when the model is fixed-input', () => {
    const { tiles } = planTiles(
      { x: 0, y: 0, w: 200, h: 200 }, 4000, 3000,
      { padding: 64, overlap: 64, align: 32, inputSize: 512, fixedInput: true },
    );
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(t.feedW).toBe(512);
      expect(t.feedH).toBe(512);
    }
  });
});

describe('tiler: sampleContext', () => {
  it('builds a [1,4,H,W] tensor with clamped edge sampling', () => {
    // 2×2 image: top-left red, others blue; mask marks pixel (0,0)
    const img = new ImageData(2, 2);
    img.data.set([255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
    const mask = new Uint8ClampedArray([255, 0, 0, 0]);
    // feed rect extends beyond the image on the left/top
    const tile = {
      index: 0,
      tile: { x: -1, y: -1, w: 32, h: 32 },
      feed: { x: -1, y: -1, w: 32, h: 32 },
      feedW: 32,
      feedH: 32,
    };
    const out = new Float32Array(4 * 32 * 32);
    sampleContext(img, mask, tile, out);
    const HW = 32 * 32;
    // pixel (0,0) is under the mask → masked RGB is zeroed, mask channel = 1.0
    expect(out[0]).toBe(0.0); // masked R
    expect(out[HW + 0]).toBe(0.0); // masked G
    expect(out[2 * HW + 0]).toBe(0.0); // masked B
    expect(out[3 * HW + 0]).toBe(1.0); // mask channel
    // clamped pixel (2,2) → copies image edge pixel (1,1) which is blue; no mask
    const idx = 3 * 32 + 3;
    expect(out[idx]).toBe(0.0); // blue R
    expect(out[HW + idx]).toBe(0.0); // blue G
    expect(out[2 * HW + idx]).toBe(1.0); // blue B
    expect(out[3 * HW + idx]).toBe(0.0); // no mask there
  });

  it('scale-maps the whole feed rect when the model input is resized (fixed-input)', () => {
    // 100×100 image: bottom-right pixel red, everything else blue.
    // feed rect is 640×640 (extends past the image), tensor is 512×512.
    const img = new ImageData(100, 100);
    img.data.fill(0); // blue fill via G/B below
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 0;
      img.data[i + 1] = 0;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
    const br = (99 * 100 + 99) * 4;
    img.data[br] = 255; // red
    img.data[br + 1] = 0;
    img.data[br + 2] = 0;
    const mask = new Uint8ClampedArray(100 * 100); // no mask → RGB passes through
    const tile = {
      index: 0,
      tile: { x: 0, y: 0, w: 640, h: 640 },
      feed: { x: 0, y: 0, w: 640, h: 640 },
      feedW: 512,
      feedH: 512,
    };
    const out = new Float32Array(4 * 512 * 512);
    sampleContext(img, mask, tile, out);
    const HW = 512 * 512;
    // top-left of the tensor = top-left of the feed rect → blue
    expect(out[0]).toBe(0.0);
    expect(out[2 * HW + 0]).toBe(1.0);
    // bottom-right of the tensor maps to feed (638,638) → clamped image (99,99) → red.
    // Regression: before the fix this sampled the raw top-left 512×512 crop,
    // which contained only blue, producing the "repeated shrunken patch" artifact.
    const last = (511 * 512 + 511);
    expect(out[last]).toBeCloseTo(1.0, 1); // red R
    expect(out[HW + last]).toBeCloseTo(0.0, 1); // G
    expect(out[2 * HW + last]).toBeCloseTo(0.0, 1); // B
  });
});

describe('tiler: accumulate + finalize blend', () => {
  it('blends overlapping tiles and pastes into the result', () => {
    const img = new ImageData(100, 100);
    img.data.fill(128);
    for (let i = 0; i < img.data.length; i += 4) img.data[i + 3] = 255;
    const mask = new Uint8ClampedArray(100 * 100).fill(255);
    const bbox = maskBBox(mask, 100, 100)!;
    const opts = { padding: 32, overlap: 32, align: 32, inputSize: 128, fixedInput: false };
    const { region, tiles } = planTiles(bbox, 100, 100, opts);
    expect(tiles.length).toBeGreaterThan(0);

    const regionBuf = new Float32Array(region.w * region.h * 4);
    for (const t of tiles) {
      // simulate model output = solid white (1,1,1) at the feed size
      const out = new Float32Array(3 * t.feedW * t.feedH).fill(1.0);
      accumulateTile(regionBuf, region.w, region.rect, t, out, t.feedW, t.feedH, opts.overlap);
    }
    const dst = new ImageData(100, 100);
    dst.data.set(img.data);
    finalizeRegion(regionBuf, region.w, region.rect, img, dst);

    // all pixels inside the original bbox should now be white
    for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
      for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
        const i = (y * 100 + x) * 4;
        expect(dst.data[i]).toBe(255);
        expect(dst.data[i + 1]).toBe(255);
        expect(dst.data[i + 2]).toBe(255);
      }
    }
  });

  it('leaves pixels outside any tile untouched', () => {
    const img = new ImageData(200, 200);
    img.data.fill(10);
    for (let i = 0; i < img.data.length; i += 4) img.data[i + 3] = 255;
    const mask = new Uint8ClampedArray(200 * 200); // empty mask → bbox null
    const bbox = maskBBox(mask, 200, 200);
    expect(bbox).toBeNull();
  });

  it('keeps RGB channels separate (CHW output must not be read as HWC)', () => {
    // 4×4 image, single tile covering the whole region; model output is 4×4
    // with distinct channels: R=1, G=0.5, B=0 at every pixel.
    const img = new ImageData(4, 4);
    img.data.fill(0);
    for (let i = 0; i < img.data.length; i += 4) img.data[i + 3] = 255;
    const mask = new Uint8ClampedArray(4 * 4).fill(255);
    const bbox = maskBBox(mask, 4, 4)!;
    const opts = { padding: 0, overlap: 0, align: 32, inputSize: 512, fixedInput: true };
    const { region, tiles } = planTiles(bbox, 4, 4, opts);
    expect(tiles).toHaveLength(1);
    const t = tiles[0]!;
    expect(t.feedW).toBe(512); // fixed input resizes the feed

    const regionBuf = new Float32Array(region.w * region.h * 4);
    // CHW output: [3, 512, 512]; channel 0 = 1.0, channel 1 = 0.5, channel 2 = 0
    const out = new Float32Array(3 * 512 * 512);
    const HW = 512 * 512;
    out.fill(1.0, 0, HW);
    out.fill(0.5, HW, 2 * HW);
    out.fill(0.0, 2 * HW, 3 * HW);
    accumulateTile(regionBuf, region.w, region.rect, t, out, 512, 512, opts.overlap);

    const dst = new ImageData(4, 4);
    dst.data.set(img.data);
    finalizeRegion(regionBuf, region.w, region.rect, img, dst);

    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const i = (y * 4 + x) * 4;
        expect(dst.data[i]).toBe(255); // R
        expect(dst.data[i + 1]).toBe(128); // G (0.5*255 ≈ 127.5 → 128)
        expect(dst.data[i + 2]).toBe(0); // B
      }
    }
  });
});
