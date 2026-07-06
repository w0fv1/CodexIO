import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { inject, injectable } from 'inversify'
import { renderMarkdownHtml, shouldRenderMarkdown } from '../../util/Markdown.js'
import { AppEvent } from '../../value/Event.js'
import { Message, MessageFile } from '../../value/Message.js'
import { IoThreadIdManager } from '../IoThreadIdManager.js'
import { EventBus } from '../EventBus.js'
import { CodexThread } from '../../value/CodexThread.js'

export type WebThread = {
  id: string
  ioThreadId: string
  agentThreadId?: string
  title: string
  isWorking: boolean
  updatedAt: number
}

export type WebThreadMessage = {
  event: 'message'
  id: string
  role: Message['role']
  ioThreadId: string
  webThreadId: string
  text: string
  createdAt: number
  html?: string
  files?: MessageFile[]
}

export type WebThreadSnapshot = {
  threads: WebThread[]
  messages: WebThreadMessage[]
}

type WebThreadManagerEventMap = {
  threads: (threads: WebThread[]) => void
}

@injectable()
export class WebThreadManager {
  private readonly threads = new Map<string, WebThread>()
  private readonly messages: WebThreadMessage[] = []
  private readonly events = new EventEmitter()

  constructor(
    @inject(IoThreadIdManager) private readonly ioThreadIdManager: IoThreadIdManager,
    @inject(EventBus) eventBus: EventBus
  ) {
    eventBus.on(AppEvent.CodexThreadChanged, (event) => {
      this.upsertAgentThreads(event.threads)
    })
    eventBus.on(AppEvent.CodexThreadBound, (event) => {
      this.bindAgentThread(event.ioThreadId, event.threadId)
    })
  }

  on<K extends keyof WebThreadManagerEventMap>(event: K, listener: WebThreadManagerEventMap[K]): () => void {
    this.events.on(event, listener)
    return () => {
      this.events.off(event, listener)
    }
  }

  createWebThread(webThreadId: string, ioThreadId: string): WebThread {
    const existing = this.threads.get(webThreadId)
    if (existing) {
      return existing
    }
    const now = Date.now()
    const thread = {
      id: webThreadId,
      ioThreadId,
      title: '',
      isWorking: false,
      updatedAt: now
    } satisfies WebThread
    this.threads.set(webThreadId, thread)
    this.emitThreads()
    return thread
  }

  bindAgentThread(ioThreadId: string, agentThreadId: string): void {
    const webThreadId = this.webThreadId(ioThreadId)
    if (!webThreadId) {
      return
    }
    const existingAgentThread = [...this.threads.values()].find((thread) => thread.agentThreadId === agentThreadId)
    const webThread = this.createWebThread(webThreadId, ioThreadId)
    if (existingAgentThread && existingAgentThread.id !== webThread.id) {
      if (!webThread.title && existingAgentThread.title) {
        webThread.title = existingAgentThread.title
      }
      webThread.isWorking = existingAgentThread.isWorking
      webThread.updatedAt = Math.max(webThread.updatedAt, existingAgentThread.updatedAt)
      this.threads.delete(existingAgentThread.id)
    }
    webThread.agentThreadId = agentThreadId
    webThread.updatedAt = Date.now()
    this.emitThreads()
  }

  upsertAgentThreads(threads: CodexThread[]): void {
    let changed = false
    for (const input of threads) {
      const existing = [...this.threads.values()].find((thread) => thread.agentThreadId === input.id)
      if (input.deleted) {
        if (existing) {
          this.threads.delete(existing.id)
          changed = true
        }
        continue
      }
      const webThreadId = existing?.id ?? `codex:${input.id}`
      const ioThreadId = existing?.ioThreadId ?? this.ioThreadIdManager.getIoThreadId({
        source: 'web',
        id: webThreadId
      })
      const previous = this.threads.get(webThreadId)
      const title = input.title.trim()
      const thread = {
        id: webThreadId,
        ioThreadId,
        agentThreadId: input.id,
        title: title.length > 0 ? title : previous?.title ?? '',
        isWorking: input.isWorking,
        updatedAt: Date.now()
      } satisfies WebThread
      if (!previous || !sameThread(previous, thread)) {
        this.threads.set(webThreadId, thread)
        changed = true
      }
    }
    if (changed) {
      this.emitThreads()
    }
  }

  appendMessage(message: Message, webThreadId: string): WebThreadMessage {
    const thread = this.createWebThread(webThreadId, message.ioThreadId)
    const data = this.toMessage(message, webThreadId)
    this.messages.push(data)
    thread.updatedAt = data.createdAt
    if (!thread.title && message.role === 'user') {
      const title = message.text.replace(/\s+/g, ' ').trim()
      if (title.length > 0) {
        thread.title = title.slice(0, 40)
      }
    }
    this.emitThreads()
    return data
  }

  snapshot(): WebThreadSnapshot {
    return {
      threads: this.listThreads(),
      messages: [...this.messages].sort((left, right) => left.createdAt - right.createdAt)
    }
  }

  listThreads(): WebThread[] {
    return [...this.threads.values()]
      .sort((left, right) => {
        if (left.isWorking !== right.isWorking) {
          return left.isWorking ? -1 : 1
        }
        return right.updatedAt - left.updatedAt
      })
      .map((thread) => ({
        ...thread
      }))
  }

  private toMessage(message: Message, webThreadId: string): WebThreadMessage {
    const data: WebThreadMessage = {
      event: 'message',
      id: randomUUID(),
      role: message.role,
      ioThreadId: message.ioThreadId,
      webThreadId,
      text: message.text,
      createdAt: Date.now()
    }
    if (message.files && message.files.length > 0) {
      data.files = message.files
    }
    if (message.role !== 'user' && shouldRenderMarkdown(message.text)) {
      data.html = renderMarkdownHtml(message.text)
    }
    return data
  }

  private webThreadId(ioThreadId: string): string | undefined {
    return this.ioThreadIdManager.getPlatformThreadId(ioThreadId)
      .find((item) => item.source === 'web')?.id
  }

  private emitThreads(): void {
    this.events.emit('threads', this.listThreads())
  }
}

function sameThread(left: WebThread, right: WebThread): boolean {
  return left.id === right.id
    && left.ioThreadId === right.ioThreadId
    && left.agentThreadId === right.agentThreadId
    && left.title === right.title
    && left.isWorking === right.isWorking
}
