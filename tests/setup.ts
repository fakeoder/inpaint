/** Test setup: jsdom lacks ImageData — provide a minimal polyfill. */
if (typeof globalThis.ImageData === 'undefined') {
  class ImageData {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  }
  (globalThis as { ImageData?: typeof ImageData }).ImageData = ImageData as unknown as typeof globalThis.ImageData;
}
