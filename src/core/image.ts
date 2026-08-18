/**
 * Image decode / encode / resize / bitmap helpers (design §2.1, §13).
 * Everything is normalized to an internal bitmap; the browser decodes
 * JPEG/PNG/WebP and we only carry around width/height + ImageBitmap.
 */
import { MAX_IMAGE_SIDE } from '../config/constants';

export interface DecodedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export class ImageDecodeError extends Error {
  constructor(public code: 'unsupported' | 'tooLarge' | 'read', message: string, public extra?: Record<string, string | number>) {
    super(message);
    this.name = 'ImageDecodeError';
  }
}

/** Decode a file (or blob) into an ImageBitmap, enforcing the side-length cap. */
export async function decodeImage(file: Blob): Promise<DecodedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageDecodeError('unsupported', 'image decode failed');
  }
  const width = bitmap.width;
  const height = bitmap.height;
  if (Math.max(width, height) > MAX_IMAGE_SIDE) {
    bitmap.close();
    throw new ImageDecodeError('tooLarge', 'image too large', { w: width, h: height, limit: MAX_IMAGE_SIDE });
  }
  return { bitmap, width, height };
}

/** Draw a bitmap into an ImageData at its natural size. */
export function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

export interface ExportOptions {
  format: 'png' | 'jpeg';
  quality?: number; // 0..1, JPEG only
}

/** Encode a canvas to a Blob. */
export function canvasToBlob(canvas: HTMLCanvasElement, opts: ExportOptions): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))),
      opts.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      opts.quality,
    );
  });
}

/** Trigger a browser download of a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
