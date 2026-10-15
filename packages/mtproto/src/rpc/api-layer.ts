import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { TlReaderMap, TlWriterMap } from '@mtcute/tl-runtime'
import { generateReaderCodeForTlEntries, generateWriterCodeForTlEntries, parseTlToEntries, type TlEntry } from '@mtcute/tl-utils'
import currentSchemaJson from '@mtcute/core/tl/api-schema.json' with { type: 'json' }
import manifestJson from '../../schema/api/manifest.json' with { type: 'json' }
import generatedHistoricalReaderMap from './generated-historical-reader-map.js'

interface SchemaRecord {
  requestedLayer: number
  reportedLayer?: number
  file?: string
  sha256?: string
  bytes?: number
  unavailable?: string
  error?: string
}

interface SchemaManifest {
  latestLayer: number
  layers: Record<string, SchemaRecord>
}

const manifest = manifestJson as SchemaManifest
const currentSchema = currentSchemaJson as {
  l: number
  e: Array<{ name: string, arguments?: Array<{ name: string, type: string }> }>
}

/** mtcute 内置 schema 对应的 API layer */
export const CURRENT_API_LAYER = currentSchema.l

const schemaRecords = new Map<number, SchemaRecord>()
for (const record of Object.values(manifest.layers)) {
  if (record.file && record.sha256) schemaRecords.set(record.requestedLayer, record)
}
const availableLayers = [...schemaRecords.values()]
  .filter((record): record is SchemaRecord & { file: string, sha256: string } => !!record.file && !!record.sha256)
  .sort((a, b) => a.requestedLayer - b.requestedLayer)
const schemaWriterCache = new WeakMap<TlWriterMap, Map<number, TlWriterMap>>()
const readerCache = new Map<number, TlReaderMap>()
let historicalReaderMap: TlReaderMap | null = null

const int53Fields = new Set(
  currentSchema.e.flatMap(entry => (entry.arguments ?? [])
    .filter(argument => argument.type === 'int53')
    .map(argument => `${entry.name}.${argument.name}`)),
)

/** 将缺失或跳号的 layer 向下对齐到本地已有的最新 schema 快照 */
export function resolveApiSchemaLayer(layer: number): number | null {
  let resolved: number | null = null
  for (const record of availableLayers) {
    if (record.requestedLayer > layer) break
    resolved = record.requestedLayer
  }
  return resolved
}

export function resolveApiSchemaProfile(layer: number): string | null {
  const resolved = resolveApiSchemaLayer(layer)
  return resolved === null ? null : 'tdlib-history'
}

/** 根据客户端协商的 API layer 生成对应的 TL writer map（自动将 mtcute 定义的 int53 字段从 long 对齐为 int53） */
export function getApiLayerWriterMap(base: TlWriterMap, layer: number | null): TlWriterMap {
  if (layer === null) return base
  const schemaLayer = resolveApiSchemaLayer(layer)
  if (schemaLayer === null) return base
  return getApiLayerSchemaWriterMap(base, schemaLayer)
}

export function getApiLayerSchemaWriterMap(base: TlWriterMap, layer: number): TlWriterMap {
  const schemaLayer = resolveApiSchemaLayer(layer)
  if (schemaLayer === null) return base
  let layers = schemaWriterCache.get(base)
  if (!layers) schemaWriterCache.set(base, layers = new Map())
  const cached = layers.get(schemaLayer)
  if (cached) return cached
  const entries = loadSchemaEntries(schemaLayer)
  augmentRecalledMessageSchema(entries)
  const code = generateWriterCodeForTlEntries(entries, {
    variableName: 'm',
    includePrelude: true,
    includeStaticSizes: true,
  })
  // eslint-disable-next-line no-new-func
  const generated = new Function(`${code};return m`)() as TlWriterMap
  const writerMap = Object.assign(Object.create(null), base, generated) as TlWriterMap
  layers.set(schemaLayer, writerMap)
  return writerMap
}

/** 在不改动官方 schema 文件的前提下，向 `message` 注入 Crossgram 的防撤回标记位 */
function augmentRecalledMessageSchema(entries: TlEntry[]): void {
  for (const entry of entries) {
    if (entry.name !== 'message') continue
    const flagsIndex = entry.arguments.findIndex((argument) => argument.type === '#')
    if (flagsIndex < 0 || entry.arguments.some((argument) => argument.name === 'recalled')) continue
    entry.arguments.splice(flagsIndex + 1, 0, {
      name: 'recalled', type: 'true', typeModifiers: { predicate: 'flags.12' },
    })
    const flags2Index = entry.arguments.findIndex((argument) => argument.name === 'flags2' && argument.type === '#')
    if (flags2Index >= 0) {
      entry.arguments.splice(flags2Index + 1, 0, {
        name: 'recalled_visible', type: 'true', typeModifiers: { predicate: 'flags2.30' },
      })
    }
  }
}

export function getApiLayerReaderMap(layer: number): TlReaderMap | null {
  const schemaLayer = resolveApiSchemaLayer(layer)
  if (schemaLayer === null) return null
  const cached = readerCache.get(schemaLayer)
  if (cached) return cached
  const code = generateReaderCodeForTlEntries(loadSchemaEntries(schemaLayer), {
    variableName: 'm',
    includeMethods: true,
    includeMethodResults: true,
  })
  // eslint-disable-next-line no-new-func
  const readerMap = new Function(`${code};return m`)() as TlReaderMap
  readerCache.set(schemaLayer, readerMap)
  return readerMap
}

/**
 * 返回汇总了所有历史 layer 构造器与方法的 reader map。
 * 这样在 `invokeWithLayer` 生效前也能直接按构造器 ID 解码旧版客户端请求；
 * 预生成产物避免了启动时解析上百份历史 schema 带来的内存峰值。
 */
export function getHistoricalApiLayerReaderMap(): TlReaderMap {
  if (historicalReaderMap) return historicalReaderMap
  historicalReaderMap = generatedHistoricalReaderMap
  return historicalReaderMap
}

export function collectNewestEntriesById<T extends { id: number }>(
  sources: Iterable<number>,
  load: (source: number) => Iterable<T>,
): T[] {
  const entries = new Map<number, T>()
  for (const source of sources) {
    for (const entry of load(source)) entries.set(entry.id, entry)
  }
  return [...entries.values()]
}

function loadSchemaEntries(schemaLayer: number): TlEntry[] {
  const record = schemaRecords.get(schemaLayer)
  if (!record?.file || !record.sha256) throw new Error(`missing local Telegram schema for layer ${schemaLayer}`)
  const schema = readFileSync(new URL(`../../schema/api/${record.file}`, import.meta.url), 'utf8')
  const digest = createHash('sha256').update(schema).digest('hex')
  if (digest !== record.sha256) throw new Error(`Telegram schema layer ${schemaLayer} failed SHA-256 validation`)
  const entries = parseTlToEntries(schema, { panicOnError: true })
  normalizeMtcuteInt53(entries)
  return entries
}

function normalizeMtcuteInt53(entries: TlEntry[]): void {
  for (const entry of entries) {
    for (const argument of entry.arguments) {
      if (argument.type === 'long' && int53Fields.has(`${entry.name}.${argument.name}`)) {
        argument.type = 'int53'
      }
    }
  }
}

/**
 * 将响应对象降级为目标客户端 layer 支持的格式。
 * 各 layer 的 writer map 以最新 schema 为基底；若不降级仅存于新 layer 的构造器
 * （如 layer 229 的 `keyboardInlineButtonRow`），旧客户端收到后会因无法解码而丢弃整个响应。
 */
export interface ApiLayerResponseAdapter {
  readonly schemaLayer: number | null
  adapt<T>(value: T): T
}

interface LayerConstructorNames {
  has(name: string): boolean
}

type ResponseDowngrade = (
  value: Record<string, unknown>,
  names: LayerConstructorNames,
) => Record<string, unknown> | undefined

// 需针对旧客户端降级的新构造器映射；无法在目标 layer 表达的节点返回 undefined 并由外层剔除。
const responseDowngrades = new Map<string, ResponseDowngrade>([
  ['keyboardInlineButtonRow', downgradeInlineKeyboardRow],
  ['keyboardInlineButton', downgradeInlineKeyboardButton],
])

const responseAdapterCache = new Map<number, ApiLayerResponseAdapter>()
const schemaConstructorNameCache = new Map<number, Set<string>>()
const identityResponseAdapter: ApiLayerResponseAdapter = { schemaLayer: null, adapt: value => value }

export function getApiLayerResponseAdapter(layer: number | null): ApiLayerResponseAdapter {
  if (layer === null) return identityResponseAdapter
  const schemaLayer = resolveApiSchemaLayer(layer)
  if (schemaLayer === null) return identityResponseAdapter
  const cached = responseAdapterCache.get(schemaLayer)
  if (cached) return cached

  const names = schemaConstructorNames(schemaLayer)
  const active: Array<[string, ResponseDowngrade]> = []
  for (const entry of responseDowngrades) {
    if (!names.has(entry[0])) active.push(entry)
  }
  const adapter: ApiLayerResponseAdapter = active.length === 0
    ? { schemaLayer, adapt: value => value }
    : {
        schemaLayer,
        adapt: <T>(value: T) => adaptResponseValue(
          value,
          new Map(active),
          { has: name => names.has(name) },
        ) as T,
      }
  responseAdapterCache.set(schemaLayer, adapter)
  return adapter
}

function schemaConstructorNames(schemaLayer: number): Set<string> {
  const cached = schemaConstructorNameCache.get(schemaLayer)
  if (cached) return cached
  const names = new Set(loadSchemaEntries(schemaLayer).map(entry => entry.name))
  schemaConstructorNameCache.set(schemaLayer, names)
  return names
}

function adaptResponseValue(
  value: unknown,
  downgrades: ReadonlyMap<string, ResponseDowngrade>,
  names: LayerConstructorNames,
): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const adapted: unknown[] = []
    for (const item of value) {
      const next = adaptResponseValue(item, downgrades, names)
      if (next !== item) changed = true
      if (next !== undefined) adapted.push(next)
    }
    return changed ? adapted : value
  }
  if (!isPlainLayerObject(value)) return value
  const object = value as Record<string, unknown>
  const name = object._
  if (typeof name === 'string') {
    const downgrade = downgrades.get(name)
    if (downgrade) {
      const converted = downgrade(object, names)
      return converted === undefined ? undefined : adaptResponseValue(converted, downgrades, names)
    }
  }
  let changed = false
  const adapted: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(object)) {
    const next = adaptResponseValue(item, downgrades, names)
    if (next !== item) changed = true
    adapted[key] = next
  }
  return changed ? adapted : value
}

/** 仅匹配普通对象，跳过 Long、TypedArray、Date 等实例 */
function isPlainLayerObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (ArrayBuffer.isView(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function downgradeInlineKeyboardRow(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const buttons = Array.isArray(value.buttons) ? value.buttons : []
  return { _: 'keyboardButtonRow', buttons }
}

function downgradeInlineKeyboardButton(
  value: Record<string, unknown>,
  names: LayerConstructorNames,
): Record<string, unknown> | undefined {
  const text = typeof value.text === 'string' ? value.text : ''
  const type = isPlainLayerObject(value.type) ? value.type : undefined
  const kind = typeof type?._ === 'string' ? type._ : 'inlineButtonTypeCallback'
  const plain = (button: Record<string, unknown>): Record<string, unknown> =>
    (value.style === undefined ? button : { ...button, style: value.style })

  // 仅当目标 layer 支持对应按钮动作时才保留，否则直接丢弃按钮。
  if (kind === 'inlineButtonTypeUrl' && typeof type?.url === 'string' && names.has('keyboardButtonUrl')) {
    return plain({ _: 'keyboardButtonUrl', text, url: type.url })
  }
  if (kind === 'inlineButtonTypeWebView' && typeof type?.url === 'string' && names.has('keyboardButtonWebView')) {
    return plain({ _: 'keyboardButtonWebView', text, url: type.url })
  }
  if (kind === 'inlineButtonTypeCopy' && typeof type?.copyText === 'string' && names.has('keyboardButtonCopy')) {
    return plain({ _: 'keyboardButtonCopy', text, copyText: type.copyText })
  }
  if (kind === 'inlineButtonTypeUserProfile' && names.has('keyboardButtonUserProfile')) {
    return plain({ _: 'keyboardButtonUserProfile', text, userId: type?.userId })
  }
  if (kind === 'inlineButtonTypeSwitchInline' && names.has('keyboardButtonSwitchInline')) {
    return plain({
      _: 'keyboardButtonSwitchInline', text, query: type?.query, samePeer: type?.samePeer,
    })
  }
  if (kind === 'inlineButtonTypeCallback' && names.has('keyboardButtonCallback')) {
    return plain({
      _: 'keyboardButtonCallback',
      text,
      data: type?.data instanceof Uint8Array ? type.data : new Uint8Array(),
      requiresPassword: type?.requiresPassword,
    })
  }
}
