import { randomUUID } from 'node:crypto'
import { injectable } from 'inversify'

export type IoThreadSource = 'web' | 'feishu' | 'email' | 'nfircoThread'
export type ChannelThreadIdValue = {
  source: IoThreadSource
  id: string
}
export type PlatformThreadId = ChannelThreadIdValue

class ChannelThreadId {
  private readonly bindings = new Map<IoThreadSource, Set<string>>()

  bind(value: ChannelThreadIdValue): void {
    const id = value.id.trim()
    if (id.length === 0) {
      throw new Error('ioThread key is required')
    }
    let sourceKeys = this.bindings.get(value.source)
    if (!sourceKeys) {
      sourceKeys = new Set<string>()
      this.bindings.set(value.source, sourceKeys)
    }
    sourceKeys.add(id)
  }

  has(value: ChannelThreadIdValue): boolean {
    const id = value.id.trim()
    if (id.length === 0) {
      return false
    }
    const sourceKeys = this.bindings.get(value.source)
    if (!sourceKeys) {
      return false
    }
    return sourceKeys.has(id)
  }

  values(): PlatformThreadId[] {
    return [...this.bindings.entries()].flatMap(([source, ids]) => [...ids].map((id) => ({
      source,
      id
    })))
  }
}

@injectable()
export class IoThreadIdManager {
  private readonly threads = new Map<string, ChannelThreadId>()
  private lastActiveIoThreadId?: string

  getIoThreadId(platformThreadId: PlatformThreadId): string {
    const existingIoThreadId = this.find(platformThreadId)
    if (existingIoThreadId) {
      this.touch(existingIoThreadId)
      return existingIoThreadId
    }
    const ioThreadId = randomUUID()
    this.bind(ioThreadId, platformThreadId)
    return ioThreadId
  }

  getPlatformThreadId(ioThreadId: string): PlatformThreadId[] {
    const normalizedIoThreadId = ioThreadId.trim()
    const thread = this.threads.get(normalizedIoThreadId)
    if (!thread) {
      return []
    }
    this.touch(normalizedIoThreadId)
    return thread.values()
  }

  getLastActiveIoThreadId(): string | undefined {
    return this.lastActiveIoThreadId
  }

  bind(ioThreadId: string, platformThreadId: PlatformThreadId): void {
    const normalizedIoThreadId = ioThreadId.trim()
    if (normalizedIoThreadId.length === 0) {
      throw new Error('ioThreadId is required')
    }
    if (platformThreadId.id.trim().length === 0) {
      throw new Error('ioThread key is required')
    }
    const existingIoThreadId = this.find(platformThreadId)
    if (existingIoThreadId && existingIoThreadId !== normalizedIoThreadId) {
      throw new Error('ioThread key already bound')
    }
    this.ensureThread(normalizedIoThreadId).bind(platformThreadId)
    this.touch(normalizedIoThreadId)
  }

  private find(channelThreadId: ChannelThreadIdValue): string | undefined {
    for (const [ioThreadId, thread] of this.threads.entries()) {
      if (thread.has(channelThreadId)) {
        return ioThreadId
      }
    }
    return undefined
  }

  private ensureThread(ioThreadId: string): ChannelThreadId {
    const normalizedIoThreadId = ioThreadId.trim()
    if (normalizedIoThreadId.length === 0) {
      throw new Error('ioThreadId is required')
    }
    const existing = this.threads.get(normalizedIoThreadId)
    if (existing) {
      return existing
    }
    const thread = new ChannelThreadId()
    this.threads.set(normalizedIoThreadId, thread)
    return thread
  }

  private touch(ioThreadId: string): void {
    const normalizedIoThreadId = ioThreadId.trim()
    if (normalizedIoThreadId.length === 0) {
      throw new Error('ioThreadId is required')
    }
    this.lastActiveIoThreadId = normalizedIoThreadId
  }
}
