// Texture decoding: BMP (paletted / 16 / 24 / 32-bit) and DDS (DXT1/3/5, uncompressed) to RGBA, plus PNG encoding.
import { deflateSync, crc32 } from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, top-down
}

export function isDds(buf: Buffer): boolean {
  return buf.length >= 4 && buf.toString('latin1', 0, 4) === 'DDS ';
}

export function isBmp(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d;
}

/** Decode a BMP. If maskIndex0 is set, palette index 0 (or the first pixel's color) becomes transparent. */
export function decodeBmp(buf: Buffer, maskIndex0 = false): RgbaImage {
  const offBits = buf.readUInt32LE(10);
  const hdrSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  let height = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  let clrUsed = buf.readUInt32LE(46);
  const topDown = height < 0;
  if (topDown) height = -height;
  const out = new Uint8Array(width * height * 4);
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const paletteOffset = 14 + hdrSize;
  let rMask = 0x00ff0000;
  let gMask = 0x0000ff00;
  let bMask = 0x000000ff;
  let aMask = 0;
  if (compression === 3 && hdrSize >= 52) {
    rMask = buf.readUInt32LE(54);
    gMask = buf.readUInt32LE(58);
    bMask = buf.readUInt32LE(62);
    if (hdrSize >= 56) aMask = buf.readUInt32LE(66);
  } else if (compression === 3 && hdrSize === 40) {
    rMask = buf.readUInt32LE(54);
    gMask = buf.readUInt32LE(58);
    bMask = buf.readUInt32LE(62);
  } else if (bpp === 16) {
    rMask = 0x7c00;
    gMask = 0x03e0;
    bMask = 0x001f;
  }
  if (bpp <= 8) {
    if (clrUsed === 0) clrUsed = 1 << bpp;
    const palette = new Uint8Array(clrUsed * 4);
    for (let i = 0; i < clrUsed; i++) {
      const p = paletteOffset + i * 4;
      palette[i * 4] = buf[p + 2];
      palette[i * 4 + 1] = buf[p + 1];
      palette[i * 4 + 2] = buf[p];
      palette[i * 4 + 3] = 255;
    }
    if (maskIndex0) palette[3] = 0;
    for (let y = 0; y < height; y++) {
      const srcRow = offBits + (topDown ? y : height - 1 - y) * rowSize;
      for (let x = 0; x < width; x++) {
        let idx: number;
        if (bpp === 8) idx = buf[srcRow + x];
        else if (bpp === 4) idx = (buf[srcRow + (x >> 1)] >> (x & 1 ? 0 : 4)) & 0x0f;
        else idx = (buf[srcRow + (x >> 3)] >> (7 - (x & 7))) & 1;
        if (idx >= clrUsed) idx = 0;
        const o = (y * width + x) * 4;
        out[o] = palette[idx * 4];
        out[o + 1] = palette[idx * 4 + 1];
        out[o + 2] = palette[idx * 4 + 2];
        out[o + 3] = palette[idx * 4 + 3];
      }
    }
    return { width, height, data: out };
  }
  const shiftOf = (m: number) => (m === 0 ? 0 : 31 - Math.clz32(m & -m));
  const bitsOf = (m: number) => (m === 0 ? 0 : 32 - Math.clz32(m) - shiftOf(m));
  const rs = shiftOf(rMask);
  const gs = shiftOf(gMask);
  const bs = shiftOf(bMask);
  const as = shiftOf(aMask);
  const rb = bitsOf(rMask);
  const gb = bitsOf(gMask);
  const bb = bitsOf(bMask);
  const ab = bitsOf(aMask);
  const expand = (v: number, bits: number) => (bits === 0 ? 255 : bits >= 8 ? v >> (bits - 8) : Math.round((v * 255) / ((1 << bits) - 1)));
  let keyColor = -1;
  for (let y = 0; y < height; y++) {
    const srcRow = offBits + (topDown ? y : height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      let px: number;
      if (bpp === 32) px = buf.readUInt32LE(srcRow + x * 4);
      else if (bpp === 24) px = buf[srcRow + x * 3] | (buf[srcRow + x * 3 + 1] << 8) | (buf[srcRow + x * 3 + 2] << 16);
      else px = buf.readUInt16LE(srcRow + x * 2);
      const o = (y * width + x) * 4;
      out[o] = expand(((px & rMask) >>> rs) >>> 0, rb);
      out[o + 1] = expand(((px & gMask) >>> gs) >>> 0, gb);
      out[o + 2] = expand(((px & bMask) >>> bs) >>> 0, bb);
      out[o + 3] = aMask ? expand(((px & aMask) >>> as) >>> 0, ab) : 255;
      if (maskIndex0) {
        const rgb = (out[o] << 16) | (out[o + 1] << 8) | out[o + 2];
        if (keyColor < 0) keyColor = rgb;
        if (rgb === keyColor) out[o + 3] = 0;
      }
    }
  }
  return { width, height, data: out };
}

function unpack565(c: number): [number, number, number] {
  const r = (c >> 11) & 0x1f;
  const g = (c >> 5) & 0x3f;
  const b = c & 0x1f;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

function decodeDxtBlockColors(buf: Buffer, p: number, out: Uint8Array, width: number, height: number, bx: number, by: number, isDxt1: boolean): void {
  const c0 = buf.readUInt16LE(p);
  const c1 = buf.readUInt16LE(p + 2);
  const bits = buf.readUInt32LE(p + 4);
  const [r0, g0, b0] = unpack565(c0);
  const [r1, g1, b1] = unpack565(c1);
  const colors = [
    [r0, g0, b0, 255],
    [r1, g1, b1, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ];
  if (!isDxt1 || c0 > c1) {
    colors[2] = [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255];
    colors[3] = [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255];
  } else {
    colors[2] = [(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2, 255];
    colors[3] = [0, 0, 0, 0];
  }
  for (let j = 0; j < 4; j++) {
    const y = by + j;
    if (y >= height) break;
    for (let i = 0; i < 4; i++) {
      const x = bx + i;
      if (x >= width) continue;
      const idx = (bits >> (2 * (j * 4 + i))) & 3;
      const c = colors[idx];
      const o = (y * width + x) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = c[3];
    }
  }
}

export function decodeDds(buf: Buffer): RgbaImage {
  if (!isDds(buf)) throw new Error('Not a DDS file');
  const height = buf.readUInt32LE(12);
  const width = buf.readUInt32LE(16);
  const pfFlags = buf.readUInt32LE(80);
  const fourCC = buf.toString('latin1', 84, 88);
  const rgbBitCount = buf.readUInt32LE(88);
  const rMask = buf.readUInt32LE(92);
  const gMask = buf.readUInt32LE(96);
  const bMask = buf.readUInt32LE(100);
  const aMask = buf.readUInt32LE(104);
  let p = 128;
  if (fourCC === 'DX10') p += 20;
  const out = new Uint8Array(width * height * 4);
  const isFourCC = (pfFlags & 0x4) !== 0;
  if (isFourCC && (fourCC === 'DXT1' || fourCC === 'DXT2' || fourCC === 'DXT3' || fourCC === 'DXT4' || fourCC === 'DXT5')) {
    const bw = Math.max(1, Math.ceil(width / 4));
    const bh = Math.max(1, Math.ceil(height / 4));
    const isDxt1 = fourCC === 'DXT1';
    const blockSize = isDxt1 ? 8 : 16;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        if (p + blockSize > buf.length) break;
        if (isDxt1) {
          decodeDxtBlockColors(buf, p, out, width, height, bx * 4, by * 4, true);
        } else if (fourCC === 'DXT3' || fourCC === 'DXT2') {
          decodeDxtBlockColors(buf, p + 8, out, width, height, bx * 4, by * 4, false);
          for (let j = 0; j < 4; j++) {
            const y = by * 4 + j;
            if (y >= height) break;
            const row = buf.readUInt16LE(p + j * 2);
            for (let i = 0; i < 4; i++) {
              const x = bx * 4 + i;
              if (x >= width) continue;
              const a = (row >> (i * 4)) & 0xf;
              out[(y * width + x) * 4 + 3] = (a << 4) | a;
            }
          }
        } else {
          decodeDxtBlockColors(buf, p + 8, out, width, height, bx * 4, by * 4, false);
          const a0 = buf[p];
          const a1 = buf[p + 1];
          const alphas = [a0, a1, 0, 0, 0, 0, 0, 0];
          if (a0 > a1) {
            for (let k = 1; k < 7; k++) alphas[k + 1] = Math.round(((7 - k) * a0 + k * a1) / 7);
          } else {
            for (let k = 1; k < 5; k++) alphas[k + 1] = Math.round(((5 - k) * a0 + k * a1) / 5);
            alphas[6] = 0;
            alphas[7] = 255;
          }
          const lo = buf[p + 2] | (buf[p + 3] << 8) | (buf[p + 4] << 16);
          const hi = buf[p + 5] | (buf[p + 6] << 8) | (buf[p + 7] << 16);
          for (let j = 0; j < 4; j++) {
            const y = by * 4 + j;
            if (y >= height) break;
            for (let i = 0; i < 4; i++) {
              const x = bx * 4 + i;
              if (x >= width) continue;
              const t = j * 4 + i;
              const bitPos = t * 3;
              const code = bitPos < 24 ? (lo >> bitPos) & 7 : (hi >> (bitPos - 24)) & 7;
              out[(y * width + x) * 4 + 3] = alphas[code];
            }
          }
        }
        p += blockSize;
      }
    }
    return { width, height, data: out };
  }
  // Uncompressed RGB(A)
  const bytesPP = rgbBitCount / 8;
  const shiftOf = (m: number) => (m === 0 ? 0 : 31 - Math.clz32(m & -m));
  const bitsOf = (m: number) => (m === 0 ? 0 : 32 - Math.clz32(m) - shiftOf(m));
  const expand = (v: number, bits: number) => (bits === 0 ? 255 : bits >= 8 ? v >> (bits - 8) : Math.round((v * 255) / ((1 << bits) - 1)));
  const hasRgb = (pfFlags & 0x40) !== 0;
  const isLum = (pfFlags & 0x20000) !== 0;
  const rs = shiftOf(rMask), gs = shiftOf(gMask), bs = shiftOf(bMask), as = shiftOf(aMask);
  const rb = bitsOf(rMask), gb = bitsOf(gMask), bb = bitsOf(bMask), ab = bitsOf(aMask);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const q = p + (y * width + x) * bytesPP;
      if (q + bytesPP > buf.length) break;
      let px = 0;
      for (let k = 0; k < bytesPP; k++) px |= buf[q + k] << (8 * k);
      px >>>= 0;
      const o = (y * width + x) * 4;
      if (hasRgb) {
        out[o] = expand(((px & rMask) >>> rs) >>> 0, rb);
        out[o + 1] = expand(((px & gMask) >>> gs) >>> 0, gb);
        out[o + 2] = expand(((px & bMask) >>> bs) >>> 0, bb);
      } else if (isLum) {
        const l = expand(((px & rMask) >>> rs) >>> 0, rb);
        out[o] = out[o + 1] = out[o + 2] = l;
      } else {
        out[o] = out[o + 1] = out[o + 2] = 255;
      }
      out[o + 3] = aMask ? expand(((px & aMask) >>> as) >>> 0, ab) : 255;
    }
  }
  return { width, height, data: out };
}

/** Decode any supported texture file. Returns undefined for unsupported formats. */
export function decodeTexture(buf: Buffer, mask = false): RgbaImage | undefined {
  if (isDds(buf)) return decodeDds(buf);
  if (isBmp(buf)) return decodeBmp(buf, mask);
  return undefined;
}

/** Downsample an image by an integer factor (box filter). */
export function downsample(img: RgbaImage, factor: number): RgbaImage {
  if (factor <= 1) return img;
  const w = Math.max(1, Math.floor(img.width / factor));
  const h = Math.max(1, Math.floor(img.height / factor));
  const out = new Uint8Array(w * h * 4);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < factor; j++) {
        for (let i = 0; i < factor; i++) {
          const o = ((y * factor + j) * img.width + (x * factor + i)) * 4;
          r += img.data[o];
          g += img.data[o + 1];
          b += img.data[o + 2];
          a += img.data[o + 3];
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

export function encodePng(img: RgbaImage): Buffer {
  const { width, height, data } = img;
  const raw = Buffer.allocUnsafe((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 4 });
  const chunks: Buffer[] = [];
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', idat));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  const c = crc32(data, crc32(Buffer.from(type, 'latin1')));
  out.writeUInt32BE(c >>> 0, 8 + data.length);
  return out;
}

/** True when any pixel has alpha < 255. */
export function hasTransparency(img: RgbaImage): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 255) return true;
  return false;
}
