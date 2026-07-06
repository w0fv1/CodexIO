import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { inject, injectable } from 'inversify'
import { renderMarkdownHtml, shouldRenderMarkdown } from '../../util/Markdown.js'
import { Message, MessageFile } from '../../value/Message.js'
import { IoThreadIdManager } from '../IoThreadIdManager.js'

export type WebThread = {
  id: string
  ioThreadId: string
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
    @inject(IoThreadIdManager) private readonly ioThreadIdManager: IoThreadIdManager
  ) {}

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

  appendMessage(message: Message, webThreadId?: string): WebThreadMessage {
    const targetWebThreadId = webThreadId?.trim() || this.displayThreadId(message.ioThreadId)
    const thread = this.createWebThread(targetWebThreadId, message.ioThreadId)
    const data = this.toMessage(message, targetWebThreadId)
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

  private displayThreadId(ioThreadId: string): string {
    return this.ioThreadIdManager.getChannelThreadIds(ioThreadId)
      .find((item) => item.source === 'web')?.id ?? `io:${ioThreadId}`
  }

  private emitThreads(): void {
    this.events.emit('threads', this.listThreads())
  }
}
