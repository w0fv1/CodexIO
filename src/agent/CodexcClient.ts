import { EventEmitter } from 'node:events'
import { CodexioMetadata } from '../component/CodexioMetadata.js'
import { CodexAppServer } from './CodexAppServer.js'

export type CodexcCommand = {
  command: string
  args: string[]
}

export type CodexcThread = {
  id: string
  title: string
  isWorking: boolean
}

export type CodexcThreadItem = {
  threadId: string
  itemId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
}

export type CodexcClientEventMap = {
  thread: (thread: CodexcThread) => void
  threadDeleted: (threadId: string) => void
  item: (item: CodexcThreadItem) => void
  notification: (notification: { method: string, params: unknown }) => void
  error: (error: Error) => void
}

type CodexcAppServerHandle = Pick<CodexAppServer, 'start' | 'request' | 'waitForNotification' | 'stop'>

export type CodexcClientOptions = {
  command?: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  metadata?: CodexioMetadata
  appServer?: CodexcAppServerHandle
  refreshIntervalMs?: number
  onStderr?: (data: Buffer) => void
}

type CodexThreadSnapshot = {
  id: string
  title: string
  isWorking: boolean
}

export class CodexcClient {
  private readonly events = new EventEmitter()
  private readonly threads = new Map<string, CodexThreadSnapshot>()
  private readonly items = new Set<string>()
  private readonly refreshIntervalMs: number
  private appServer?: CodexcAppServerHandle
  private refreshTimer?: NodeJS.Timeout
  private refreshRunning = false
  private started = false

  constructor(private readonly options: CodexcClientOptions = {}) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? 0
  }

  on<K extends keyof CodexcClientEventMap>(event: K, listener: CodexcClientEventMap[K]): () => void {
    this.events.on(event, listener)
    return () => {
      this.events.off(event, listener)
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }
    this.appServer = this.options.appServer ?? this.createAppServer()
    await this.appServer.start()
    this.started = true
    if (this.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => {
        void this.refresh().catch((error) => {
          this.emitError(error)
        })
      }, this.refreshIntervalMs)
    }
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = undefined
    }
    await this.appServer?.stop()
    this.appServer = undefined
    this.started = false
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.appServer) {
      throw new Error('codex client not started')
    }
    return await this.appServer.request(method, params) as T
  }

  async waitForNotification(method: string): Promise<void> {
    if (!this.appServer) {
      throw new Error('codex client not started')
    }
    await this.appServer.waitForNotification(method)
  }

  async refresh(): Promise<void> {
    if (this.refreshRunning || !this.started) {
      return
    }
    this.refreshRunning = true
    try {
      const seen = new Set<string>()
      let cursor: string | null | undefined
      do {
        const response = await this.request<Record<string, unknown>>('thread/list', {
          cursor,
          limit: 50,
          archived: false,
          sortDirection: 'desc'
        })
        const threads = Array.isArray(response.data) ? response.data : []
        for (const value of threads) {
          const thread = this.readThread(value)
          if (!thread) {
            continue
          }
          seen.add(thread.id)
          const refreshed = await this.refreshThread(thread)
          if (!this.threads.has(refreshed.id) && !refreshed.isWorking) {
            continue
          }
          this.upsertThread(refreshed)
          if (refreshed.isWorking) {
            await this.refreshThreadItems(thread.id)
          }
        }
        cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null
      } while (cursor)
      for (const threadId of this.threads.keys()) {
        if (!seen.has(threadId)) {
          this.threads.delete(threadId)
          this.events.emit('threadDeleted', threadId)
        }
      }
    } finally {
      this.refreshRunning = false
    }
  }

  handleNotification(method: string, params: unknown): void {
    this.events.emit('notification', {
      method,
      params
    })
    if (!params || typeof params !== 'object') {
      return
    }
    const data = params as Record<string, unknown>
    if (method === 'thread/started') {
      const thread = this.readThread(data.thread)
      if (thread) {
        this.upsertThread(thread)
      }
      return
    }
    if (method === 'thread/name/updated') {
      const threadId = readString(data, 'threadId')
      if (threadId && typeof data.threadName === 'string') {
        this.upsertThread({
          id: threadId,
          title: data.threadName,
          isWorking: this.threads.get(threadId)?.isWorking ?? false
        })
      }
      return
    }
    if (method === 'thread/status/changed') {
      const threadId = readString(data, 'threadId')
      if (threadId) {
        this.upsertThread({
          id: threadId,
          title: this.threads.get(threadId)?.title ?? '',
          isWorking: this.isActiveStatus(data.status)
        })
      }
      return
    }
    if (method === 'turn/started') {
      const threadId = readString(data, 'threadId')
      if (threadId) {
        this.upsertThread({
          id: threadId,
          title: this.threads.get(threadId)?.title ?? '',
          isWorking: true
        })
      }
      return
    }
    if (method === 'turn/completed') {
      const threadId = readString(data, 'threadId')
      if (threadId) {
        this.upsertThread({
          id: threadId,
          title: this.threads.get(threadId)?.title ?? '',
          isWorking: false
        })
      }
      return
    }
    if (method === 'item/completed') {
      return
    }
    if (method === 'thread/deleted' || method === 'thread/archived' || method === 'thread/closed') {
      const threadId = readString(data, 'threadId')
      if (threadId) {
        this.threads.delete(threadId)
        this.events.emit('threadDeleted', threadId)
      }
    }
  }

  private createAppServer(): CodexcAppServerHandle {
    if (!this.options.command || !this.options.args || !this.options.cwd || !this.options.env || !this.options.metadata) {
      throw new Error('codex client app-server options are incomplete')
    }
    return new CodexAppServer({
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd,
      env: this.options.env,
      metadata: this.options.metadata,
      onNotification: (method, params) => {
        this.handleNotification(method, params)
      },
      onStderr: this.options.onStderr ?? (() => {})
    })
  }

  private async refreshThread(thread: CodexcThread): Promise<CodexcThread> {
    const response = await this.request<Record<string, unknown>>('thread/read', {
      threadId: thread.id
    })
    return this.readThread(response.thread) ?? thread
  }

  private async refreshThreadItems(threadId: string): Promise<void> {
    let cursor: string | null | undefined
    do {
      const response = await this.request<Record<string, unknown>>('thread/turns/list', {
        threadId,
        cursor,
        limit: 1,
        sortDirection: 'desc'
      })
      const turns = Array.isArray(response.data) ? response.data : []
      for (const turn of turns) {
        this.emitTurnItems(threadId, turn)
      }
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null
    } while (cursor)
  }

  private emitTurnItems(threadId: string, turn: unknown): void {
    if (!turn || typeof turn !== 'object') {
      return
    }
    const items = (turn as Record<string, unknown>).items
    if (!Array.isArray(items)) {
      return
    }
    for (const item of items) {
      this.emitItem(threadId, item)
    }
  }

  private emitItem(threadId: string, item: unknown): void {
    if (!item || typeof item !== 'object') {
      return
    }
    const data = item as Record<string, unknown>
    const itemId = readString(data, 'id')
    const itemType = readString(data, 'type')
    if (!itemId || !itemType) {
      return
    }
    const key = `${threadId}:${itemId}`
    if (this.items.has(key)) {
      return
    }
    if (itemType === 'agentMessage' && typeof data.text === 'string' && data.text.trim().length > 0) {
      this.items.add(key)
      this.events.emit('item', {
        threadId,
        itemId,
        role: 'assistant',
        text: data.text
      })
      return
    }
    if (itemType === 'userMessage' && Array.isArray(data.content)) {
      const text = data.content.map((value) => readString(value, 'text')).filter((value): value is string => Boolean(value)).join('\n')
      if (text.trim().length > 0) {
        this.items.add(key)
        this.events.emit('item', {
          threadId,
          itemId,
          role: 'user',
          text
        })
      }
    }
  }

  private readThread(value: unknown): CodexcThread | null {
    if (!value || typeof value !== 'object') {
      return null
    }
    const id = readString(value, 'id')
    if (!id) {
      return null
    }
    return {
      id,
      title: readString(value, 'name') ?? readString(value, 'preview') ?? '',
      isWorking: this.isActiveStatus((value as Record<string, unknown>).status)
    }
  }

  private upsertThread(thread: CodexcThread): void {
    const existing = this.threads.get(thread.id)
    if (existing && existing.title === thread.title && existing.isWorking === thread.isWorking) {
      return
    }
    this.threads.set(thread.id, thread)
    this.events.emit('thread', thread)
  }

  private isActiveStatus(value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).type === 'active')
  }

  private emitError(error: unknown): void {
    this.events.emit('error', error instanceof Error ? error : new Error(String(error)))
  }
}

function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' ? item : null
}
