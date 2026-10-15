interface PromiseCacheEntry<T> {
  promise: Promise<T>
  settled: boolean
}

/** 近期 Promise 去重缓存：仅淘汰已完成的条目，进行中的操作绝不淘汰，防止高并发下同一副作用重复执行。 */
export class RecentPromiseCache<T> {
  private readonly entries = new Map<string, PromiseCacheEntry<T>>()

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new RangeError('maximum must be a positive integer')
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string): Promise<T> | undefined {
    const entry = this.entries.get(key)
    if (!entry) return
    this.touch(key, entry)
    return entry.promise
  }

  set(key: string, promise: Promise<T>): void {
    const entry: PromiseCacheEntry<T> = { promise, settled: false }
    this.entries.delete(key)
    this.entries.set(key, entry)
    void promise.then(() => {
      if (this.entries.get(key) !== entry) return
      entry.settled = true
      this.touch(key, entry)
      this.trim()
    }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })
    this.trim()
  }

  private touch(key: string, entry: PromiseCacheEntry<T>): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private trim(): void {
    while (this.entries.size > this.maximum) {
      const oldestSettled = [...this.entries].find(([, entry]) => entry.settled)
      if (!oldestSettled) return
      this.entries.delete(oldestSettled[0])
    }
  }
}
