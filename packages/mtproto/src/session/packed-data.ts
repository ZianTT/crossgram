import { inflateRawSync, unzipSync } from 'node:zlib'

export const MAX_PACKED_DATA_UNPACKED_SIZE = 16 * 1024 * 1024

/**
 * 解压 `gzip_packed` 载荷。
 * 协议文档规定为 gzip，但部分 TDLib 客户端会发送 zlib 或裸 DEFLATE 流；
 * 因此先尝试 `unzipSync`（兼容 gzip/zlib），失败后回退到 `inflateRawSync`，并统一限制解压后大小防止内存炸弹。
 */
export function unpackPackedData(packedData: Uint8Array): Uint8Array {
  const options = { maxOutputLength: MAX_PACKED_DATA_UNPACKED_SIZE }

  try {
    const unpacked = unzipSync(packedData, options)
    return new Uint8Array(unpacked.buffer, unpacked.byteOffset, unpacked.byteLength)
  } catch (wrappedError) {
    try {
      const unpacked = inflateRawSync(packedData, options)
      return new Uint8Array(unpacked.buffer, unpacked.byteOffset, unpacked.byteLength)
    } catch (rawError) {
      throw new AggregateError(
        [wrappedError, rawError],
        'Unable to decompress gzip_packed payload as gzip, zlib, or raw DEFLATE',
      )
    }
  }
}
