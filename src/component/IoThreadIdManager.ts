import { randomUUID } from 'node:crypto'
import { rename, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { inject, injectable } from 'inversify'
import { z } from 'zod'
import { CodexioMetadata } from './CodexioMetadata.js'
import { Logger } from './Logger.js'

export type IoThreadSource = 'web' | 'feishu' | 'email' | 'nfirco'
export type ChannelThreadIdValue = {
  source: IoThreadSource
  id: string
}
export type PlatformThreadId = ChannelThreadIdValue

const PlatformThreadIdSchema = z.object({
  source: z.enum([
    'web',
    'feishu',
    'email',
    'nfirco'
  ]),
  id: z.string().trim().min(1)
})

const IoThreadStateSchema = z.object({
  version: z.literal(1),
  lastActiveIoThreadId: z.string().trim().min(1).optional(),
  threads: z.array(z.object({
    ioThreadId: z.string().trim().min(1),
    platformThreadIds: z.array(PlatformThreadIdSchema),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive()
  }))
})

type IoThreadState = z.infer<typeof IoThreadStateSchema>

class ChannelThreadId {
  private readonly bindings = new Map<IoThreadSource, Set<string>>()
  createdAt: number
  updatedAt: number

  constructor(createdAt = Date.now(), updatedAt = createdAt) {
    this.createdAt = createdAt
    this.updatedAt = updatedAt
  }

  bind(value: ChannelThreadIdValue): boolean {
    const id = value.id.trim()
    if (id.length === 0) {
      throw new Error('ioThread key is required')
    }
    let sourceKeys = this.bindings.get(value.source)
    if (!sourceKeys) {
      sourceKeys = new Set<string>()
      this.bindings.set(value.source, sourceKeys)
    }
    if (sourceKeys.has(id)) {
      return false
    }
    sourceKeys.add(id)
    this.updatedAt = Date.now()
    return true
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
  private readonly statePath: string
  private lastActiveIoThreadId?: string
  private persistQueue = Promise.resolve()
  private persistError?: Error

  constructor(@inject(CodexioMetadata) metadata: CodexioMetadata) {
    this.statePath = metadata.ioThreadStatePath
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
    const state = IoThreadStateSchema.parse(JSON.parse(text))
    const restored = new Map<string, ChannelThreadId>()
    const ioThreadIdByPlatformThreadId = new Map<string, string>()
    for (const item of state.threads) {
      if (restored.has(item.ioThreadId)) {
        throw new Error(`ioThreadId duplicated in state: ${item.ioThreadId}`)
      }
      const thread = new ChannelThreadId(item.createdAt, item.updatedAt)
      for (const platformThreadId of item.platformThreadIds) {
        const key = this.platformThreadKey(platformThreadId)
        const existingIoThreadId = ioThreadIdByPlatformThreadId.get(key)
        if (existingIoThreadId && existingIoThreadId !== item.ioThreadId) {
          throw new Error(`ioThread key already bound in state: ${platformThreadId.source}:${platformThreadId.id}`)
        }
        ioThreadIdByPlatformThreadId.set(key, item.ioThreadId)
        thread.bind(platformThreadId)
      }
      thread.createdAt = item.createdAt
      thread.updatedAt = item.updatedAt
      restored.set(item.ioThreadId, thread)
    }
    if (state.lastActiveIoThreadId && !restored.has(state.lastActiveIoThreadId)) {
      throw new Error('lastActiveIoThreadId not found in state')
    }
    this.threads.clear()
    for (const [ioThreadId, thread] of restored.entries()) {
      this.threads.set(ioThreadId, thread)
    }
    this.lastActiveIoThreadId = state.lastActiveIoThreadId
  }

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
    const changed = this.ensureThread(normalizedIoThreadId).bind(platformThreadId)
    this.touch(normalizedIoThreadId, changed)
  }

  async flush(): Promise<void> {
    await this.persistQueue
    if (this.persistError) {
      throw this.persistError
    }
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

  private touch(ioThreadId: string, forcePersist = false): void {
    const normalizedIoThreadId = ioThreadId.trim()
    if (normalizedIoThreadId.length === 0) {
      throw new Error('ioThreadId is required')
    }
    const thread = this.threads.get(normalizedIoThreadId)
    if (thread) {
      thread.updatedAt = Date.now()
    }
    const changed = this.lastActiveIoThreadId !== normalizedIoThreadId || Boolean(thread)
    this.lastActiveIoThreadId = normalizedIoThreadId
    if (changed || forcePersist) {
      this.persist()
    }
  }

  private persist(): void {
    this.persistQueue = this.persistQueue.then(() => this.persistNow()).catch((error) => {
      this.persistError = error instanceof Error ? error : new Error(String(error))
      Logger.error('ioThread state persist failed', this.persistError)
    })
  }

  private async persistNow(): Promise<void> {
    const path = this.statePath
    const tempPath = `${path}.tmp`
    await mkdir(dirname(path), {
      recursive: true
    })
    await writeFile(tempPath, JSON.stringify(this.toState(), null, 2), 'utf8')
    await rename(tempPath, path)
  }

  private toState(): IoThreadState {
    return {
      version: 1,
      lastActiveIoThreadId: this.lastActiveIoThreadId,
      threads: [...this.threads.entries()].map(([ioThreadId, thread]) => ({
        ioThreadId,
        platformThreadIds: thread.values(),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt
      }))
    }
  }

  private platformThreadKey(platformThreadId: PlatformThreadId): string {
    return `${platformThreadId.source}\u0000${platformThreadId.id.trim()}`
  }
}
