/**
 * 忽略键顺序的 JSON 序列化与结构对比。
 * PostgreSQL jsonb 不保留原始键顺序，直接对比 `JSON.stringify()` 会导致每次读取都把未变更的记录误判为已修改。
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']'
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return JSON.stringify(value) ?? 'null'
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return '{' + entries
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item))
    .join(',') + '}'
}

export function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false
  return canonicalJson(left) === canonicalJson(right)
}

/** 判断 `expected` 中的所有字段是否都与 `container` 一致（忽略 `container` 中由存储层额外维护的字段）。 */
export function jsonContains(container: unknown, expected: unknown): boolean {
  if (jsonEquals(container, expected)) return true
  if (Array.isArray(container) && Array.isArray(expected)) {
    return container.length === expected.length
      && expected.every((item, index) => jsonContains(container[index], item))
  }
  if (!container || !expected || typeof container !== 'object' || typeof expected !== 'object') {
    return false
  }
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    if (value === undefined) continue
    if (!jsonContains((container as Record<string, unknown>)[key], value)) return false
  }
  return true
}
