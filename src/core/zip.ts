/**
 * Minimal ZIP writer (no compression, "stored" method) for batch export.
 *
 * Images are already compressed (PNG/JPEG), so a stored archive adds ~0 bytes
 * of size while bundling all results into one download. Implemented with the
 * standard ZIP structures: local file headers + central directory + EOCD.
 */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function utf8(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

export interface ZipEntry {
  name: string;
  data: Uint8Array<ArrayBuffer>;
}

/** Bundle entries into a stored-method ZIP archive. */
export function zipBlobs(entries: ZipEntry[]): Blob {
  const names = entries.map((e) => utf8(e.name));
  const parts: BlobPart[] = [];
  const localOffsets: number[] = [];
  let offset = 0;

  // local file headers + data
  for (let i = 0; i < entries.length; i++) {
    const { data } = entries[i]!;
    const name = names[i]!;
    const crc = crc32(data);
    const head = new Uint8Array(30 + name.length);
    const v = new DataView(head.buffer);
    writeU32(v, 0, 0x04034b50); // local file header signature
    writeU16(v, 4, 20); // version needed
    writeU16(v, 6, 0x0800); // UTF-8 flag
    writeU16(v, 8, 0); // method: stored
    writeU16(v, 10, 0); // mod time
    writeU16(v, 12, 0); // mod date
    writeU32(v, 14, crc);
    writeU32(v, 18, data.length);
    writeU32(v, 22, data.length);
    writeU16(v, 26, name.length);
    writeU16(v, 28, 0); // extra len
    head.set(name, 30);
    localOffsets.push(offset);
    offset += head.length + data.length;
    parts.push(head, data);
  }

  // central directory (variable-length entries: 46 + name)
  const cdSize = entries.reduce((acc, e, i) => acc + 46 + names[i]!.length, 0);
  const cd = new Uint8Array(cdSize + 22); // + EOCD
  const v = new DataView(cd.buffer);
  let p = 0;
  for (let i = 0; i < entries.length; i++) {
    const { data } = entries[i]!;
    const name = names[i]!;
    writeU32(v, p, 0x02014b50); // central directory signature
    writeU16(v, p + 4, 20); // version made by
    writeU16(v, p + 6, 20); // version needed
    writeU16(v, p + 8, 0x0800); // UTF-8 flag
    writeU16(v, p + 10, 0); // method
    writeU16(v, p + 12, 0); // time
    writeU16(v, p + 14, 0); // date
    writeU32(v, p + 16, crc32(data));
    writeU32(v, p + 20, data.length);
    writeU32(v, p + 24, data.length);
    writeU16(v, p + 28, name.length);
    writeU16(v, p + 30, 0); // extra len
    writeU16(v, p + 32, 0); // comment len
    writeU16(v, p + 34, 0); // disk number
    writeU16(v, p + 36, 0); // internal attrs
    writeU32(v, p + 38, 0); // external attrs
    writeU32(v, p + 42, localOffsets[i]!);
    cd.set(name, p + 46);
    p += 46 + name.length;
  }
  // end of central directory
  const e = p;
  writeU32(v, e, 0x06054b50);
  writeU16(v, e + 4, 0);
  writeU16(v, e + 6, 0);
  writeU16(v, e + 8, entries.length);
  writeU16(v, e + 10, entries.length);
  writeU32(v, e + 12, cdSize);
  writeU32(v, e + 16, offset);
  writeU16(v, e + 20, 0); // comment len

  parts.push(cd);
  return new Blob(parts, { type: 'application/zip' });
}
