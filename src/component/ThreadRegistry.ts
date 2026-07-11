import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { inject, injectable } from 'inversify'
import { z } from 'zod'
import { MessageThread } from '../value/Message.js'
import { CodexioMetadata } from './CodexioMetadata.js'
import { Logger } from './Logger.js'

export type IoThreadSource = 'web' | 'feishu' | 'email' | 'nfirco'

export type ChannelThreadId = {
  source: IoThreadSource
  id: string
}

type ThreadRegistryEventMap = {
  renamed: (thread: MessageThread) => void
}

const ChannelThreadIdSchema = z.object({
  source: z.enum(['web', 'feishu', 'email', 'nfirco']),
  id: z.string().trim().min(1)
})

const ThreadStateSchema = z.object({
  version: z.literal(3),
  lastActiveThreadId: z.string().trim().min(1).optional(),
  threads: z.array(z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    channelThreadIds: z.array(ChannelThreadIdSchema),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive()
  }))
})

type ThreadState = z.infer<typeof ThreadStateSchema>

class RegisteredThread {
  private readonly bindings = new Map<IoThreadSource, string>()

  constructor(
    readonly id: string,
    public name: string,
    public createdAt = Date.now(),
    public updatedAt = createdAt
  ) {}

  bind(value: ChannelThreadId): boolean {
    const id = value.id.trim()
    if (!id) {
      throw new Error('thread key is required')
    }
    const existing = this.bindings.get(value.source)
    if (existing === id) {
      return false
    }
    if (existing) {
      throw new Error('thread source already bound')
    }
    this.bindings.set(value.source, id)
    this.updatedAt = Date.now()
    return true
  }

  has(value: ChannelThreadId): boolean {
    return this.bindings.get(value.source) === value.id.trim()
  }

  values(): ChannelThreadId[] {
    return [...this.bindings.entries()].map(([source, id]) => ({ source, id }))
  }

  value(): MessageThread {
    return {
      id: this.id,
      name: this.name
    }
  }
}

@injectable()
export class ThreadRegistry {
  private readonly threads = new Map<string, RegisteredThread>()
  private readonly events = new EventEmitter()
  private readonly statePath: string
  private lastActiveThreadId?: string
  private persistQueue = Promise.resolve()
  private persistError?: Error

  constructor(@inject(CodexioMetadata) metadata: CodexioMetadata) {
    this.statePath = metadata.ioThreadStatePath
  }

  on<K extends keyof ThreadRegistryEventMap>(event: K, listener: ThreadRegistryEventMap[K]): () => void {
    this.events.on(event, listener)
    return () => this.events.off(event, listener)
  }

  async init(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }
    const state = ThreadStateSchema.parse(JSON.parse(text))
    const restored = new Map<string, RegisteredThread>()
    const owners = new Map<string, string>()
    for (const item of state.threads) {
      if (restored.has(item.id)) {
        throw new Error(`thread id duplicated in state: ${item.id}`)
      }
      const thread = new RegisteredThread(item.id, item.name, item.createdAt, item.updatedAt)
      for (const channelThreadId of item.channelThreadIds) {
        const key = this.channelThreadKey(channelThreadId)
        const owner = owners.get(key)
        if (owner && owner !== item.id) {
          throw new Error(`thread key already bound in state: ${channelThreadId.source}:${channelThreadId.id}`)
        }
        owners.set(key, item.id)
        thread.bind(channelThreadId)
      }
      thread.createdAt = item.createdAt
      thread.updatedAt = item.updatedAt
      restored.set(item.id, thread)
    }
    if (state.lastActiveThreadId && !restored.has(state.lastActiveThreadId)) {
      throw new Error('last active thread not found in state')
    }
    this.threads.clear()
    for (const [id, thread] of restored) {
      this.threads.set(id, thread)
    }
    this.lastActiveThreadId = state.lastActiveThreadId
    Logger.info('thread registry restored', {
      threadCount: this.threads.size,
      bindingCount: [...this.threads.values()].reduce((count, thread) => count + thread.values().length, 0),
      lastActiveThreadId: this.lastActiveThreadId ?? null
    })
  }

  resolve(channelThreadId: ChannelThreadId, preferredName?: string, initialName?: string): MessageThread {
    const existing = this.find(channelThreadId)
    if (existing) {
      if (preferredName?.trim()) {
        this.rename(existing.id, preferredName)
      }
      this.touch(existing.id)
      Logger.info('thread registry resolved channel thread', {
        resolution: 'existing',
        channelSource: channelThreadId.source,
        channelThreadId: channelThreadId.id,
        ioThreadId: existing.id,
        bindings: existing.values()
      })
      return existing.value()
    }
    const thread = new RegisteredThread(randomUUID(), normalizeThreadName(preferredName ?? initialName))
    thread.bind(channelThreadId)
    this.threads.set(thread.id, thread)
    this.touch(thread.id, true)
    Logger.info('thread registry resolved channel thread', {
      resolution: 'created',
      channelSource: channelThreadId.source,
      channelThreadId: channelThreadId.id,
      ioThreadId: thread.id,
      bindings: thread.values()
    })
    return thread.value()
  }

  ensure(id: string, preferredName?: string): MessageThread {
    const normalizedId = id.trim()
    if (!normalizedId) {
      throw new Error('thread id is required')
    }
    const existing = this.threads.get(normalizedId)
    if (existing) {
      if (preferredName?.trim()) {
        this.rename(existing.id, preferredName)
      }
      this.touch(existing.id)
      return existing.value()
    }
    const thread = new RegisteredThread(normalizedId, normalizeThreadName(preferredName))
    this.threads.set(thread.id, thread)
    this.touch(thread.id, true)
    return thread.value()
  }

  get(id: string): MessageThread | undefined {
    return this.threads.get(id.trim())?.value()
  }

  getLastActive(): MessageThread | undefined {
    return this.lastActiveThreadId ? this.get(this.lastActiveThreadId) : undefined
  }

  getChannelThreadIds(threadId: string): ChannelThreadId[] {
    const thread = this.threads.get(threadId.trim())
    if (!thread) {
      return []
    }
    this.touch(thread.id)
    return thread.values()
  }

  bind(threadId: string, channelThreadId: ChannelThreadId): void {
    const thread = this.ensure(threadId)
    const existing = this.find(channelThreadId)
    if (existing && existing.id !== thread.id) {
      Logger.warn('thread registry channel binding conflicted', {
        channelSource: channelThreadId.source,
        channelThreadId: channelThreadId.id,
        requestedIoThreadId: thread.id,
        existingIoThreadId: existing.id
      })
      throw new Error('thread key already bound')
    }
    const changed = this.threads.get(thread.id)?.bind(channelThreadId) ?? false
    this.touch(thread.id, changed)
    Logger.info('thread registry bound channel thread', {
      changed,
      channelSource: channelThreadId.source,
      channelThreadId: channelThreadId.id,
      ioThreadId: thread.id,
      bindings: this.threads.get(thread.id)?.values() ?? []
    })
  }

  rename(threadId: string, name: string): MessageThread {
    const thread = this.threads.get(threadId.trim())
    if (!thread) {
      return this.ensure(threadId, name)
    }
    const normalizedName = normalizeThreadName(name)
    if (thread.name === normalizedName) {
      return thread.value()
    }
    thread.name = normalizedName
    thread.updatedAt = Date.now()
    this.persist()
    const value = thread.value()
    this.events.emit('renamed', value)
    return value
  }

  async flush(): Promise<void> {
    await this.persistQueue
    if (this.persistError) {
      throw this.persistError
    }
  }

  private find(channelThreadId: ChannelThreadId): RegisteredThread | undefined {
    for (const thread of this.threads.values()) {
      if (thread.has(channelThreadId)) {
        return thread
      }
    }
    return undefined
  }

  private touch(threadId: string, forcePersist = false): void {
    const thread = this.threads.get(threadId)
    if (thread) {
      thread.updatedAt = Date.now()
    }
    const changed = this.lastActiveThreadId !== threadId
    this.lastActiveThreadId = threadId
    if (changed || forcePersist) {
      this.persist()
    }
  }

  private persist(): void {
    this.persistQueue = this.persistQueue.then(() => this.persistNow()).catch((error) => {
      this.persistError = error instanceof Error ? error : new Error(String(error))
      Logger.error('thread state persist failed', this.persistError)
    })
  }

  private async persistNow(): Promise<void> {
    const tempPath = `${this.statePath}.tmp`
    await mkdir(dirname(this.statePath), { recursive: true })
    await writeFile(tempPath, JSON.stringify(this.toState(), null, 2), 'utf8')
    await rename(tempPath, this.statePath)
  }

  private toState(): ThreadState {
    return {
      version: 3,
      lastActiveThreadId: this.lastActiveThreadId,
      threads: [...this.threads.values()].map((thread) => ({
        id: thread.id,
        name: thread.name,
        channelThreadIds: thread.values(),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt
      }))
    }
  }

  private channelThreadKey(channelThreadId: ChannelThreadId): string {
    return `${channelThreadId.source}\u0000${channelThreadId.id.trim()}`
  }
}

export function normalizeThreadName(value?: string): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? ''
  return normalized ? normalized.slice(0, 80) : '新对话'
}
