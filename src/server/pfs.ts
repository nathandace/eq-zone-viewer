// PFS archive reader (EverQuest .s3d / .eqg / .pfs / .pak containers).
// Layout: [u32 dirOffset]["PFS "][u32 version] ... compressed file blocks ...
//         dir @ dirOffset: [u32 count] count x { i32 crc, u32 offset, u32 size }
//         The entry with crc 0x61580AC9 is the filename list.
//         Each file is a chain of blocks: { u32 deflatedLen, u32 inflatedLen, bytes } until inflated == size.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export interface PfsEntry {
  name: string;
  crc: number;
  offset: number;
  size: number;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) {
      c = (c & 0x80000000) !== 0 ? ((c << 1) ^ 0x04c11db7) : (c << 1);
    }
    t[i] = c;
  }
  return t;
})();

export function pfsCrc(name: string): number {
  let c = 0;
  const bytes = Buffer.from(name + '\0', 'latin1');
  for (let i = 0; i < bytes.length; i++) {
    const b = (bytes[i] << 24) >> 24; // sign-extend like int8_t
    const idx = ((c >> 24) ^ b) & 0xff;
    c = (c << 8) ^ CRC_TABLE[idx];
  }
  return c | 0;
}

const FILENAME_CRC = 0x61580ac9 | 0;

export class PfsArchive {
  readonly entries = new Map<string, PfsEntry>();
  private cache = new Map<string, Buffer>();

  private readonly buf: Buffer;
  readonly path: string;

  private constructor(buf: Buffer, path: string) {
    this.buf = buf;
    this.path = path;
  }

  static open(path: string): PfsArchive {
    return PfsArchive.fromBuffer(readFileSync(path), path);
  }

  static fromBuffer(buf: Buffer, path = ''): PfsArchive {
    const a = new PfsArchive(buf, path);
    a.parseDirectory();
    return a;
  }

  private parseDirectory(): void {
    const buf = this.buf;
    if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'PFS ') {
      throw new Error(`Not a PFS archive: ${this.path}`);
    }
    const dirOffset = buf.readUInt32LE(0);
    const count = buf.readUInt32LE(dirOffset);
    const raw: { crc: number; offset: number; size: number }[] = [];
    let nameListEntry: { offset: number; size: number } | undefined;
    for (let i = 0; i < count; i++) {
      const p = dirOffset + 4 + i * 12;
      const crc = buf.readInt32LE(p);
      const offset = buf.readUInt32LE(p + 4);
      const size = buf.readUInt32LE(p + 8);
      if (crc === FILENAME_CRC) nameListEntry = { offset, size };
      else raw.push({ crc, offset, size });
    }
    if (!nameListEntry) return;
    const names = PfsArchive.inflateAt(buf, nameListEntry.offset, nameListEntry.size);
    const nameCount = names.readUInt32LE(0);
    const list: string[] = [];
    let p = 4;
    for (let i = 0; i < nameCount; i++) {
      const len = names.readUInt32LE(p);
      p += 4;
      let s = names.toString('latin1', p, p + len);
      p += len;
      const nul = s.indexOf('\0');
      if (nul >= 0) s = s.slice(0, nul);
      list.push(s.toLowerCase());
    }
    // Match names to entries by CRC; fall back to offset order for anything that does not match.
    const byCrc = new Map<number, { crc: number; offset: number; size: number }>();
    for (const e of raw) byCrc.set(e.crc, e);
    const used = new Set<number>();
    const pending: string[] = [];
    for (const name of list) {
      const e = byCrc.get(pfsCrc(name));
      if (e && !used.has(e.offset)) {
        used.add(e.offset);
        this.entries.set(name, { name, crc: e.crc, offset: e.offset, size: e.size });
      } else {
        pending.push(name);
      }
    }
    if (pending.length) {
      const leftover = raw.filter((e) => !used.has(e.offset)).sort((a, b) => a.offset - b.offset);
      for (let i = 0; i < pending.length && i < leftover.length; i++) {
        const e = leftover[i];
        this.entries.set(pending[i], { name: pending[i], crc: e.crc, offset: e.offset, size: e.size });
      }
    }
  }

  private static inflateAt(buf: Buffer, offset: number, size: number, maxBytes = Infinity): Buffer {
    const out = Buffer.allocUnsafe(maxBytes === Infinity ? size : Math.min(size, maxBytes));
    let pos = offset;
    let inflated = 0;
    while (inflated < size && inflated < out.length) {
      const deflatedLen = buf.readUInt32LE(pos);
      const inflatedLen = buf.readUInt32LE(pos + 4);
      const chunk = inflateSync(buf.subarray(pos + 8, pos + 8 + deflatedLen));
      const n = Math.min(chunk.length, out.length - inflated);
      chunk.copy(out, inflated, 0, n);
      inflated += inflatedLen;
      pos += 8 + deflatedLen;
    }
    return out;
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase());
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  namesWithExt(ext: string): string[] {
    const e = ext.toLowerCase();
    return this.names().filter((n) => n.endsWith(e));
  }

  /** Inflate a whole file. Returns undefined if not present. */
  get(name: string): Buffer | undefined {
    const key = name.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const e = this.entries.get(key);
    if (!e) return undefined;
    const data = PfsArchive.inflateAt(this.buf, e.offset, e.size);
    this.cache.set(key, data);
    return data;
  }

  /** Inflate only the first bytes of a file. */
  getHead(name: string, n: number): Buffer | undefined {
    const e = this.entries.get(name.toLowerCase());
    if (!e) return undefined;
    return PfsArchive.inflateAt(this.buf, e.offset, e.size, n);
  }

  get byteLength(): number {
    return this.buf.length;
  }
}
