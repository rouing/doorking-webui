// Reader for MFC CArchive files (little-endian, length-prefixed strings, class tags).
export class ArchiveReader {
  buf: Buffer;
  pos: number;
  classes: { name: string; schema: number }[];

  constructor(buffer: Buffer) {
    this.buf = buffer;
    this.pos = 0;
    this.classes = [];
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  u8(): number {
    return this.buf[this.pos++];
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

  bytes(n: number): Buffer {
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  // CString: 1-byte length, or 0xFF + 2-byte length, or 0xFF 0xFFFF + 4-byte length.
  string(): string {
    let n = this.u8();
    if (n === 0xff) {
      n = this.u16();
      if (n === 0xffff) n = this.u32();
    }
    return this.buf.toString('latin1', this.pos, (this.pos += n));
  }

  // Object tag before a serialized CObject. Returns the class name.
  // 0xFFFF = new class (schema + name follow); 0x8000|index = class seen before.
  classTag(): string {
    const tag = this.u16();
    if (tag === 0xffff) {
      const schema = this.u16();
      const nameLen = this.u16();
      const name = this.buf.toString('latin1', this.pos, (this.pos += nameLen));
      this.classes.push({ name, schema });
      return name;
    }
    if (tag & 0x8000) {
      const cls = this.classes[(tag & 0x7fff) - 1];
      if (!cls) throw new Error(`Unknown class index ${tag & 0x7fff} at 0x${(this.pos - 2).toString(16)}`);
      return cls.name;
    }
    throw new Error(`Unexpected object tag 0x${tag.toString(16)} at 0x${(this.pos - 2).toString(16)}`);
  }
}
