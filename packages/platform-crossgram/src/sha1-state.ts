/**
 * 支持导出未填充中间压缩状态（h0..h4 小端序）的增量 SHA-1。
 * QQ 视频 Highway 上传要求每 1 MiB 边界上报原始 SHA-1 内部状态而非填充后的摘要，最后一个分片才上报完整摘要。
 */
export class Sha1CompressionState {
  private readonly _state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0])
  private readonly _words = new Uint32Array(80)
  private readonly _block = Buffer.alloc(64)
  private _blockLength = 0

  update(input: Uint8Array): void {
    let offset = 0
    if (this._blockLength) {
      const accepted = Math.min(input.length, 64 - this._blockLength)
      this._block.set(input.subarray(0, accepted), this._blockLength)
      this._blockLength += accepted
      offset = accepted
      if (this._blockLength < 64) return
      this._compress(this._block, 0)
      this._blockLength = 0
    }
    const view = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
    for (; offset + 64 <= view.length; offset += 64) this._compress(view, offset)
    if (offset < view.length) {
      this._block.set(view.subarray(offset), 0)
      this._blockLength = view.length - offset
    }
  }

  /** 导出未填充的内部状态，仅在 64 字节块边界上有效。 */
  stateLittleEndian(): Buffer {
    if (this._blockLength) throw new Error('SHA-1 state checkpoint is not aligned to a 64-byte block')
    const output = Buffer.allocUnsafe(20)
    for (let index = 0; index < 5; index++) output.writeUInt32LE(this._state[index]!, index * 4)
    return output
  }

  private _compress(input: Buffer, offset: number): void {
    const words = this._words
    for (let index = 0; index < 16; index++) words[index] = input.readUInt32BE(offset + index * 4)
    for (let index = 16; index < 80; index++) {
      const value = words[index - 3]! ^ words[index - 8]! ^ words[index - 14]! ^ words[index - 16]!
      words[index] = (value << 1) | (value >>> 31)
    }
    let [a, b, c, d, e] = this._state as unknown as [number, number, number, number, number]
    for (let index = 0; index < 80; index++) {
      const f = index < 20 ? (b & c) | (~b & d)
        : index < 40 ? b ^ c ^ d
          : index < 60 ? (b & c) | (b & d) | (c & d)
            : b ^ c ^ d
      const k = index < 20 ? 0x5a827999 : index < 40 ? 0x6ed9eba1 : index < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const next = (((a << 5) | (a >>> 27)) + f + e + k + words[index]!) >>> 0
      e = d
      d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = next
    }
    this._state[0] += a
    this._state[1] += b
    this._state[2] += c
    this._state[3] += d
    this._state[4] += e
  }
}
