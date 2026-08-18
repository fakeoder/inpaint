/**
 * High-resolution tiled inference helpers (design §5) — pure functions.
 *
 * Strategy: crop the mask bbox + padding into an "inference region"; if the
 * region is larger than the model input S, slide a 32-aligned window over it;
 * each tile is fed with an extra `overlap` context margin (resized to S×S when
 * larger than the model input); overlapping areas are blended with a
 * distance-weighted gradient (feathering); the blended pixels are pasted back
 * into a full-size result buffer.
 *
 * Region/tile coordinates are in image space and may extend beyond the image
 * edges (edge pixels are copied to fill the context, per design §5.2).
 */
import type { MaskRect } from './mask';

export interface TilingOptions {
  padding: number; // context around the mask bbox
  overlap: number; // context fed around each tile
  align: number; // LaMa inputs must be H/W multiples of this
  inputSize: number; // model input edge S
  fixedInput: boolean; // model requires exactly inputSize×inputSize
}

export interface Tile {
  index: number;
  /** The kept region of this tile (image coords, may extend past edges). */
  tile: MaskRect;
  /** The context rect fed to the model (image coords). */
  feed: MaskRect;
  /** Tensor H/W after alignment / resize decision. */
  feedW: number;
  feedH: number;
}

export interface Region {
  /** Inference region rect (bbox + padding) in image coords. */
  rect: MaskRect;
  /** Region dimensions. */
  w: number;
  h: number;
}

function alignUp(v: number, a: number): number {
  return Math.ceil(v / a) * a;
}

/** Build the inference region: mask bbox + padding (may exceed image edges). */
export function planRegion(bbox: MaskRect, opts: Pick<TilingOptions, 'padding'>): Region {
  const x = bbox.x - opts.padding;
  const y = bbox.y - opts.padding;
  return {
    rect: { x, y, w: bbox.w + opts.padding * 2, h: bbox.h + opts.padding * 2 },
    w: bbox.w + opts.padding * 2,
    h: bbox.h + opts.padding * 2,
  };
}

/**
 * Slide a window over the region and produce the tile list. Adjacent tiles
 * overlap by `overlap` (step = S − overlap) so the feathering at tile edges
 * never leaves gaps: in an overlap band, distance to the two tile edges sums
 * to `overlap`, so the blended weights sum to ~1. Tile sizes stay 32-aligned;
 * the last row/column may be smaller (still aligned up).
 */
export function planTiles(bbox: MaskRect, _imgW: number, _imgH: number, opts: TilingOptions): { region: Region; tiles: Tile[] } {
  const region = planRegion(bbox, opts);
  const S = opts.inputSize;
  const tiles: Tile[] = [];

  // overlap the kept regions so edge weights never drop to zero
  const step = Math.max(opts.align, S - opts.overlap);
  const cols = Math.max(1, Math.ceil(region.w / step));
  const rows = Math.max(1, Math.ceil(region.h / step));

  let index = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileX = region.rect.x + col * step;
      const tileY = region.rect.y + row * step;
      // tile kept size: min(S, remaining), aligned up (may slightly exceed the
      // region edge — that's fine, sampling clamps to the image/edge pixels)
      let tileW = Math.min(S, region.rect.x + region.w - tileX);
      let tileH = Math.min(S, region.rect.y + region.h - tileY);
      tileW = alignUp(tileW, opts.align);
      tileH = alignUp(tileH, opts.align);

      // feed = tile + overlap on all sides
      const feedX = tileX - opts.overlap;
      const feedY = tileY - opts.overlap;
      const feedW = alignUp(tileW + opts.overlap * 2, opts.align);
      const feedH = alignUp(tileH + opts.overlap * 2, opts.align);

      let tensorW = feedW;
      let tensorH = feedH;
      if (opts.fixedInput || feedW > S || feedH > S) {
        // resize the context to the model input
        tensorW = S;
        tensorH = S;
      }

      tiles.push({
        index: index++,
        tile: { x: tileX, y: tileY, w: tileW, h: tileH },
        feed: { x: feedX, y: feedY, w: feedW, h: feedH },
        feedW: tensorW,
        feedH: tensorH,
      });
    }
  }
  return { region, tiles };
}

/** Clamp-sampled bilinear pixel read (edge pixels copied when outside the image). */
function samplePixel(image: ImageData, mask: Uint8ClampedArray | null, x: number, y: number, w: number, h: number, out: [number, number, number, number]): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const cx0 = Math.min(w - 1, Math.max(0, x0));
  const cy0 = Math.min(h - 1, Math.max(0, y0));
  const i00 = (cy0 * w + cx0) * 4;
  const i01 = (cy0 * w + x1) * 4;
  const i10 = (y1 * w + cx0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const w00 = (1 - fx) * (1 - fy);
  const w01 = fx * (1 - fy);
  const w10 = (1 - fx) * fy;
  const w11 = fx * fy;
  for (let c = 0; c < 3; c++) {
    out[c] = (image.data[i00 + c]! * w00 + image.data[i01 + c]! * w01 + image.data[i10 + c]! * w10 + image.data[i11 + c]! * w11) / 255;
  }
  out[3] = mask ? mask[cy0 * w + cx0]! / 255 : 0;
}

/**
 * Sample the feed context into a [1,4,feedH,feedW] NCHW float tensor
 * (channels 0–2: MASKED RGB — pixels under the mask are zeroed, matching the
 * LaMa training distribution; channel 3: binary mask 0..1), normalized to 0..1.
 *
 * Feeding the raw image under the mask makes the model see an out-of-distribution
 * input and it degrades to blank/flat output ("painted white").
 *
 * When the model input is resized (fixed-input models: feedW < feed.w), the
 * WHOLE feed rect is scale-mapped into the tensor — sampling the raw top-left
 * corner instead would feed the model a shifted crop, and pasting that back
 * produces the "repeated shrunken patches" artifact.
 */
export function sampleContext(
  image: ImageData,
  mask: Uint8ClampedArray,
  tile: Tile,
  out: Float32Array,
): void {
  const imgW = image.width;
  const imgH = image.height;
  const HW = tile.feedH * tile.feedW;
  const px: [number, number, number, number] = [0, 0, 0, 0];
  const fx = tile.feed.x;
  const fy = tile.feed.y;
  const sx = tile.feed.w / tile.feedW;
  const sy = tile.feed.h / tile.feedH;
  for (let y = 0; y < tile.feedH; y++) {
    const imgY = fy + y * sy;
    for (let x = 0; x < tile.feedW; x++) {
      samplePixel(image, mask, fx + x * sx, imgY, imgW, imgH, px);
      const base = y * tile.feedW + x;
      // Binarize the mask: painting is a SELECTION, not a graded brush — any
      // painted pixel (alpha > 0) is part of the region, so soft brush edges
      // and overlapping strokes must not change the model input (LaMa expects
      // a binary mask, design §5.1/§6.1).
      const m = px[3] > 0 ? 1 : 0;
      // masked RGB: zero out whatever sits under the mask (LaMa contract)
      out[base] = px[0] * (1 - m);
      out[HW + base] = px[1] * (1 - m);
      out[2 * HW + base] = px[2] * (1 - m);
      out[3 * HW + base] = m;
    }
  }
}

/** Bilinear-resize a CHW float tensor from (ih×iw) to (oh×ow). */
export function resizeTensor(src: Float32Array, channels: number, iw: number, ih: number, ow: number, oh: number): Float32Array {
  if (iw === ow && ih === oh) return src;
  const dst = new Float32Array(channels * ow * oh);
  const sx = iw / ow;
  const sy = ih / oh;
  for (let c = 0; c < channels; c++) {
    const cOff = c * iw * ih;
    const dOff = c * ow * oh;
    for (let y = 0; y < oh; y++) {
      const srcY = y * sy;
      const y0 = Math.floor(srcY);
      const y1 = Math.min(ih - 1, y0 + 1);
      const fy = srcY - y0;
      for (let x = 0; x < ow; x++) {
        const srcX = x * sx;
        const x0 = Math.floor(srcX);
        const x1 = Math.min(iw - 1, x0 + 1);
        const fx = srcX - x0;
        const i00 = cOff + y0 * iw + x0;
        const i01 = cOff + y0 * iw + x1;
        const i10 = cOff + y1 * iw + x0;
        const i11 = cOff + y1 * iw + x1;
        const v = src[i00]! * (1 - fx) * (1 - fy) + src[i01]! * fx * (1 - fy) + src[i10]! * (1 - fx) * fy + src[i11]! * fx * fy;
        dst[dOff + y * ow + x] = v;
      }
    }
  }
  return dst;
}

/**
 * Feather weight of a pixel inside a tile: 1 in the interior, fading to 0
 * over the `overlap` band at the tile edges (design §5.2 feathering).
 */
function featherWeight(x: number, y: number, tile: MaskRect, overlap: number): number {
  const dx = Math.min(x - tile.x, tile.x + tile.w - 1 - x);
  const dy = Math.min(y - tile.y, tile.y + tile.h - 1 - y);
  const d = Math.min(dx, dy);
  if (overlap <= 0) return 1;
  return Math.min(1, Math.max(0, d / overlap));
}

/**
 * Accumulate a model output tile into the region blend buffer.
 * Region buffer layout: one row per region pixel, 4 floats (r,g,b,w).
 * `output` is [3, outH, outW] (model output, 0..1); it is resized back to the
 * feed size before accumulation.
 */
export function accumulateTile(
  regionBuf: Float32Array,
  regionW: number,
  regionRect: MaskRect,
  tile: Tile,
  output: Float32Array,
  outW: number,
  outH: number,
  overlap: number,
): void {
  const resized = resizeTensor(output, 3, outW, outH, tile.feed.w, tile.feed.h);
  // `resized` is CHW ([3, feedH, feedW]): channel c's pixel (x,y) lives at
  // c*HW + y*feed.w + x. Reading it as HWC ((y*feed.w+x)*3) misreads each
  // "RGB" from one channel's consecutive pixels — corrupting the output into
  // repeated/smeared patches (the reported artifact).
  const HW = tile.feed.h * tile.feed.w;
  for (let y = 0; y < tile.feed.h; y++) {
    const imgY = tile.feed.y + y;
    if (imgY < regionRect.y || imgY >= regionRect.y + regionRect.h) continue;
    const rowIdx = (imgY - regionRect.y) * regionW;
    const rowBase = y * tile.feed.w;
    for (let x = 0; x < tile.feed.w; x++) {
      const imgX = tile.feed.x + x;
      if (imgX < regionRect.x || imgX >= regionRect.x + regionRect.w) continue;
      // only accumulate within the tile's kept region
      if (imgX < tile.tile.x || imgX >= tile.tile.x + tile.tile.w) continue;
      if (imgY < tile.tile.y || imgY >= tile.tile.y + tile.tile.h) continue;
      const w = featherWeight(imgX, imgY, tile.tile, overlap);
      if (w <= 0) continue;
      const base = rowBase + x;
      const srcR = base;
      const srcG = HW + base;
      const srcB = 2 * HW + base;
      const dst = (rowIdx + (imgX - regionRect.x)) * 4;
      regionBuf[dst]! += resized[srcR]! * w;
      regionBuf[dst + 1]! += resized[srcG]! * w;
      regionBuf[dst + 2]! += resized[srcB]! * w;
      regionBuf[dst + 3]! += w;
    }
  }
}

/**
 * Normalize the blend buffer and paste it into a full-size result ImageData
 * (which must already be a copy of the original). Pixels with no coverage
 * keep the original image (they were outside any tile).
 */
export function finalizeRegion(
  regionBuf: Float32Array,
  regionW: number,
  regionRect: MaskRect,
  srcImage: ImageData,
  dst: ImageData,
): void {
  for (let y = 0; y < regionRect.h; y++) {
    const imgY = regionRect.y + y;
    if (imgY < 0 || imgY >= srcImage.height) continue;
    for (let x = 0; x < regionRect.w; x++) {
      const imgX = regionRect.x + x;
      if (imgX < 0 || imgX >= srcImage.width) continue;
      const i = (y * regionW + x) * 4;
      const w = regionBuf[i + 3]!;
      if (w <= 0) continue;
      const o = (imgY * srcImage.width + imgX) * 4;
      dst.data[o] = Math.round(regionBuf[i]! / w * 255);
      dst.data[o + 1] = Math.round(regionBuf[i + 1]! / w * 255);
      dst.data[o + 2] = Math.round(regionBuf[i + 2]! / w * 255);
      dst.data[o + 3] = srcImage.data[o + 3]!; // preserve alpha
    }
  }
}
