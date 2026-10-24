/** 容量受限的 Map：超出 `maximum` 时淘汰最早写入的条目，覆写已有键会刷新其顺序。 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maximum: number) {
    if (maximum !== Number.POSITIVE_INFINITY
      && (!Number.isInteger(maximum) || maximum < 1)) {
      throw new RangeError('maximum must be a positive integer or Infinity')
    }
    super()
  }

  get limit(): number {
    return this.maximum
  }

  override set(key: K, value: V): this {
    super.delete(key)
    super.set(key, value)
    while (this.size > this.maximum) {
      const oldest = this.keys().next()
      if (oldest.done) break
      super.delete(oldest.value)
    }
    return this
  }
}
