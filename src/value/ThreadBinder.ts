import { randomUUID } from 'node:crypto'

export class ThreadBinder {
  private readonly ioThreadIdByKey = new Map<string, string>()

  resolve(keys: string[]): string | undefined {
    for (const key of this.normalizeKeys(keys)) {
      const ioThreadId = this.ioThreadIdByKey.get(key)
      if (ioThreadId) {
        return ioThreadId
      }
    }
    return undefined
  }

  bind(ioThreadId: string, keys: string[]): void {
    const normalizedIoThreadId = ioThreadId.trim()
    if (normalizedIoThreadId.length === 0) {
      throw new Error('ioThreadId is required')
    }
    const normalizedKeys = this.normalizeKeys(keys)
    if (normalizedKeys.length === 0) {
      throw new Error('thread binding key is required')
    }
    for (const key of normalizedKeys) {
      this.ioThreadIdByKey.set(key, normalizedIoThreadId)
    }
  }

  resolveOrCreate(keys: string[]): string {
    const normalizedKeys = this.normalizeKeys(keys)
    if (normalizedKeys.length === 0) {
      throw new Error('thread binding key is required')
    }
    const existing = this.resolve(normalizedKeys)
    if (existing) {
      this.bind(existing, normalizedKeys)
      return existing
    }
    const ioThreadId = randomUUID()
    this.bind(ioThreadId, normalizedKeys)
    return ioThreadId
  }

  private normalizeKeys(keys: string[]): string[] {
    return [...new Set(keys.map((key) => key.trim()).filter((key) => key.length > 0))]
  }
}
