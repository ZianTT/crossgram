import type { TlReaderMap } from '@mtcute/tl-runtime'
import { parseFullTlSchema, parseTlToEntries, generateReaderCodeForTlEntries, type TlEntry } from '@mtcute/tl-utils'
import { __tlReaderMap } from '@mtcute/core/utils.js'
import apiSchemaRaw from '@mtcute/core/tl/api-schema.json' with { type: 'json' }
import mtpSchemaRaw from '@mtcute/core/tl/mtp-schema.json' with { type: 'json' }
import { getHistoricalApiLayerReaderMap } from './api-layer.js'

let _serverReaderMap: TlReaderMap | null = null

// mtcute 客户端 schema 省略了服务端才需要解码的握手构造器（如 TDLib/Desktop 仍在使用的旧版 req_pq#60469778）。
const EXTRA_MTP_SCHEMA = `
req_pq#60469778 nonce:int128 = ResPQ;
`

// Telegram Android 在声明最新 layer 时仍会发送这些不在公开 TDLib 历史 schema 中的旧构造器。
const TELEGRAM_ANDROID_COMPAT_SCHEMA = `
gzip_packed#3072cfa1 packed_data:bytes = Object;

---functions---
channels.getMessages#93d7b347 channel:InputChannel id:Vector<int> = messages.Messages;
langpack.getLanguages#800fd57d = Vector<LangPackLanguage>;
account.registerDevice#637ea878 token_type:int token:string = Bool;
`

/** Crossgram 客户端扩展 TL 定义 */
export const CROSSGRAM_API_SCHEMA = `
---functions---
crossgram.getFileUrl#7520f6ea location:InputFileLocation = DataJSON;
crossgram.prepareMediaUpload#f75adc0e peer:InputPeer file_id:long name:string size:long kind:string mime_type:string md5:bytes sha1:bytes file10m_md5:bytes width:int height:int duration:double = Bool;
crossgram.prepareMediaUploadV2#f75adc0f peer:InputPeer file_id:long name:string size:long kind:string mime_type:string md5:bytes sha1:bytes sha1_checkpoints:bytes file10m_md5:bytes width:int height:int duration:double = Bool;
crossgram.prepareMediaUploadV3#f75adc10 peer:InputPeer file_id:long name:string size:long kind:string mime_type:string md5:bytes sha1:bytes sha1_checkpoints:bytes file10m_md5:bytes width:int height:int duration:double thumbnail:bytes thumbnail_width:int thumbnail_height:int = Bool;
crossgram.getFeatures#c3e6b915 peer:InputPeer = DataJSON;
crossgram.sendPoke#9a2d47f0 peer:InputPeer user_id:InputUser count:int = Bool;
`

/**
 * 构建服务端 TL reader map。
 * mtcute 内置的 `__tlReaderMap` 仅含响应类型；服务端需合并当前与历史 layer 的 RPC 请求方法解码器。
 */
export function getServerReaderMap(): TlReaderMap {
  if (_serverReaderMap) return _serverReaderMap

  const apiSchema = parseFullTlSchema((apiSchemaRaw.e ?? apiSchemaRaw) as unknown as TlEntry[])
  const mtpSchema = parseFullTlSchema(mtpSchemaRaw as unknown as TlEntry[])

  const compatApiEntries = parseTlToEntries(`${TELEGRAM_ANDROID_COMPAT_SCHEMA}\n${CROSSGRAM_API_SCHEMA}`)
  const apiEntries = [
    ...apiSchema.entries,
    ...compatApiEntries.filter(e => !apiSchema.entries.some(x => x.id === e.id)),
  ]

  const extraMtpEntries = parseTlToEntries(EXTRA_MTP_SCHEMA, { prefix: 'mt_' })
  const mtpEntries = [
    ...mtpSchema.entries,
    ...extraMtpEntries.filter(e => !mtpSchema.entries.some(x => x.id === e.id)),
  ]

  const removeInternal = (entries: typeof apiSchema.entries) =>
    entries.filter(it => !it.name.startsWith('mtcute.') || it.name === 'mtcute.customMethod')

  let code = generateReaderCodeForTlEntries(removeInternal(apiEntries), {
    variableName: 'm',
    includeMethods: true,
    includeMethodResults: true,
  })

  const mtpCode = generateReaderCodeForTlEntries(mtpEntries, { variableName: 'm' })
  code = code.substring(0, code.length - 1) + mtpCode.substring(8)
  code += '\nreturn m;'

  // eslint-disable-next-line no-new-func
  const generated = new Function(code)() as TlReaderMap

  _serverReaderMap = Object.assign(
    Object.create(null),
    __tlReaderMap,
    getHistoricalApiLayerReaderMap(),
    generated,
  ) as TlReaderMap

  return _serverReaderMap
}
