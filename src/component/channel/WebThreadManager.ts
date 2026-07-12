import { EventEmitter } from 'node:events'
import { inject, injectable } from 'inversify'
import { renderMarkdownHtml, shouldRenderMarkdown } from '../../util/Markdown.js'
import { Message, MessageFile, MessageThread } from '../../value/Message.js'
import { ThreadRegistry } from '../ThreadRegistry.js'

export type WebThread = {
  id: string
  thread: MessageThread
  isWorking: boolean
  updatedAt: number
}

export type WebThreadMessage = {
  event: 'message'
  id: string
  role: Message['role']
  thread: MessageThread
  webThreadId: string
  text: string
  occurredAt: number
  html?: string
  files?: MessageFile[]
}

export type WebThreadSnapshot = {
  threads: WebThread[]
  messages: WebThreadMessage[]
}

type WebThreadManagerEventMap = {
  threads: (threads: WebThread[]) => void
  message: (message: WebThreadMessage) => void
}

@injectable()
export class WebThreadManager {
  private readonly threads = new Map<string, WebThread>()
  private readonly messages = new Map<string, WebThreadMessage>()
  private readonly events = new EventEmitter()

  constructor(
    @inject(ThreadRegistry) private readonly threadRegistry: ThreadRegistry
  ) {
    this.threadRegistry.on('renamed', (thread) => {
      let changed = false
      for (const webThread of this.threads.values()) {
        if (webThread.thread.id === thread.id && webThread.thread.name !== thread.name) {
          webThread.thread = { ...thread }
          changed = true
        }
      }
      for (const message of this.messages.values()) {
        if (message.thread.id === thread.id && message.thread.name !== thread.name) {
          message.thread = { ...thread }
          changed = true
        }
      }
      if (changed) {
        this.emitThreads()
      }
    })
  }

  on<K extends keyof WebThreadManagerEventMap>(event: K, listener: WebThreadManagerEventMap[K]): () => void {
    this.events.on(event, listener)
    return () => {
      this.events.off(event, listener)
    }
  }

  appendMessage(message: Message, webThreadId?: string): WebThreadMessage {
    const existing = this.messages.get(message.id)
    if (existing) {
      return existing
    }
    const targetWebThreadId = webThreadId?.trim() || this.displayThreadId(message.thread.id)
    let thread = this.threads.get(targetWebThreadId)
    if (!thread) {
      thread = {
        id: targetWebThreadId,
        thread: this.threadRegistry.get(message.thread.id) ?? { ...message.thread },
        isWorking: false,
        updatedAt: message.occurredAt
      }
      this.threads.set(targetWebThreadId, thread)
    }
    const data = this.toMessage({
      ...message,
      thread: thread.thread
    }, targetWebThreadId)
    this.messages.set(message.id, data)
    thread.updatedAt = Math.max(thread.updatedAt, message.occurredAt)
    this.emitThreads()
    this.events.emit('message', data)
    return data
  }

  snapshot(): WebThreadSnapshot {
    return {
      threads: this.listThreads(),
      messages: [...this.messages.values()]
        .sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id))
        .map((message) => ({
          ...message,
          thread: { ...message.thread },
          files: message.files?.map((file) => ({ ...file }))
        }))
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
        ...thread,
        thread: {
          ...thread.thread
        }
      }))
  }

  private toMessage(message: Message, webThreadId: string): WebThreadMessage {
    const data: WebThreadMessage = {
      event: 'message',
      id: message.id,
      role: message.role,
      thread: { ...message.thread },
      webThreadId,
      text: message.text,
      occurredAt: message.occurredAt
    }
    if (message.files && message.files.length > 0) {
      data.files = message.files.map((file) => ({ ...file }))
    }
    if (message.role !== 'user' && shouldRenderMarkdown(message.text)) {
      data.html = renderMarkdownHtml(message.text)
    }
    return data
  }

  private displayThreadId(ioThreadId: string): string {
    return this.threadRegistry.getChannelThreadIds(ioThreadId)
      .find((item) => item.source === 'web')?.id ?? `io:${ioThreadId}`
  }

  private emitThreads(): void {
    this.events.emit('threads', this.listThreads())
  }
}
