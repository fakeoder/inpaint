import { describe, expect, it } from 'vitest';
import { zipBlobs } from '../src/core/zip';

/** Minimal ZIP reader for tests: extracts {name, data} from a stored archive. */
function unzip(buf: ArrayBuffer): { name: string; data: Uint8Array }[] {
  const u8 = new Uint8Array(buf);
  const v = new DataView(buf);
  // find EOCD (scan backwards for signature 0x06054b50)
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThan(0);
  const count = v.getUint16(eocd + 10, true);
  const cdStart = v.getUint32(eocd + 16, true);
  const out: { name: string; data: Uint8Array }[] = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50); // central dir signature
    const nameLen = v.getUint16(p + 28, true);
    const compSize = v.getUint32(p + 20, true);
    const localOffset = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    // local header: 30 bytes + name, then raw data
    const dataStart = localOffset + 30 + nameLen;
    out.push({ name, data: u8.slice(dataStart, dataStart + compSize) });
    p += 46 + nameLen;
  }
  return out;
}

describe('zip: stored archive', () => {
  it('packages entries with names and exact bytes', async () => {
    const a = new TextEncoder().encode('hello');
    const b = new Uint8Array([1, 2, 3, 255]);
    const blob = zipBlobs([
      { name: 'a.txt', data: a },
      { name: 'b.bin', data: b },
    ]);
    const extracted = unzip(await blob.arrayBuffer());
    expect(extracted).toHaveLength(2);
    expect(extracted[0]!.name).toBe('a.txt');
    expect([...extracted[0]!.data]).toEqual([...a]);
    expect(extracted[1]!.name).toBe('b.bin');
    expect([...extracted[1]!.data]).toEqual([...b]);
  });

  it('supports unicode filenames and large-ish payloads', async () => {
    const data = new Uint8Array(65_537).map((_, i) => i % 256);
    const blob = zipBlobs([{ name: '照片-1.png', data }]);
    const extracted = unzip(await blob.arrayBuffer());
    expect(extracted[0]!.name).toBe('照片-1.png');
    expect([...extracted[0]!.data]).toEqual([...data]);
  });
});
