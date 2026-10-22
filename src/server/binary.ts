// Little-endian binary reader over a Buffer.
export class Reader {
  pos: number;
  readonly buf: Buffer;

  constructor(buf: Buffer, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  get length(): number {
    return this.buf.length;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  u8(): number {
    return this.buf[this.pos++];
  }

  i8(): number {
    const v = this.buf.readInt8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  i16(): number {
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  f32(): number {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Buffer {
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  skip(n: number): void {
    this.pos += n;
  }

  /** Fixed-length latin1 string. */
  fixed(n: number): string {
    const s = this.buf.toString('latin1', this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  /** Null-terminated latin1 string. */
  cstr(): string {
    let end = this.pos;
    while (end < this.buf.length && this.buf[end] !== 0) end++;
    const s = this.buf.toString('latin1', this.pos, end);
    this.pos = Math.min(end + 1, this.buf.length);
    return s;
  }
}

/** Read a null-terminated string starting at an offset inside a buffer. */
export function cstrAt(buf: Buffer, offset: number): string {
  if (offset < 0 || offset >= buf.length) return '';
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString('latin1', offset, end);
}
