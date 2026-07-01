import { inject, injectable } from 'inversify'
import { AppEvent } from '../../value/Event.js'
import { Result } from '../../value/Result.js'
import { EventBus } from '../EventBus.js'
import { Logger } from '../Logger.js'

export type CodexStreamThread = {
  ioThreadId: string
  agentThreadId: string
}

export type CodexStreamMessage = {
  itemId: string
  text: string
}

type StreamItem = CodexStreamThread & {
  itemId: string
  buffer: string
  sending: Promise<void>
  receivedDelta: boolean
}

@injectable()
export class CodexMessageStreamer {
  private readonly items = new Map<string, StreamItem>()

  constructor(
    @inject(EventBus) private readonly eventBus: EventBus
  ) {}

  async append(thread: CodexStreamThread, itemId: string, delta: string): Promise<void> {
    const item = this.getItem(thread, itemId)
    item.receivedDelta = true
    item.buffer += delta
    await this.flushCompletedSegments(item)
  }

  async complete(thread: CodexStreamThread, messages: CodexStreamMessage[]): Promise<void> {
    for (const message of messages) {
      const key = this.key(thread.agentThreadId, message.itemId)
      const item = this.items.get(key)
      if (item?.receivedDelta) {
        await this.flushRemaining(item)
        this.items.delete(key)
        continue
      }
      await this.send(thread, message.text)
    }
  }

  clearThread(ioThreadId: string): void {
    for (const [key, item] of this.items.entries()) {
      if (item.ioThreadId === ioThreadId) {
        this.items.delete(key)
      }
    }
  }

  clear(): void {
    this.items.clear()
  }

  private getItem(thread: CodexStreamThread, itemId: string): StreamItem {
    const key = this.key(thread.agentThreadId, itemId)
    const existing = this.items.get(key)
    if (existing) {
      return existing
    }
    const item: StreamItem = {
      ...thread,
      itemId,
      buffer: '',
      sending: Promise.resolve(),
      receivedDelta: false
    }
    this.items.set(key, item)
    return item
  }

  private async flushCompletedSegments(item: StreamItem): Promise<void> {
    let boundary = findDoubleNewlineBoundary(item.buffer)
    while (boundary >= 0) {
      const segment = item.buffer.slice(0, boundary)
      item.buffer = item.buffer.slice(boundary).trimStart()
      await this.queueSend(item, segment)
      boundary = findDoubleNewlineBoundary(item.buffer)
    }
  }

  private async flushRemaining(item: StreamItem): Promise<void> {
    await item.sending
    const segment = item.buffer
    item.buffer = ''
    await this.queueSend(item, segment)
  }

  private async queueSend(item: StreamItem, text: string): Promise<void> {
    const segment = text.trim()
    if (segment.length === 0) {
      return
    }
    item.sending = item.sending.then(() => this.send(item, segment))
    await item.sending
  }

  private async send(thread: CodexStreamThread, text: string): Promise<void> {
    const segment = text.trim()
    if (segment.length === 0) {
      return
    }
    const results = await this.eventBus.emitAsync(AppEvent.ChannelMessageSendRequested, {
      message: {
        ioThreadId: thread.ioThreadId,
        role: 'agent',
        text: segment
      }
    })
    const failures = results.filter((result): result is Result<void> => result.isFailed)
    for (const failure of failures) {
      Logger.warn('codex agent output failed', {
        message: failure.message
      })
    }
  }

  private key(agentThreadId: string, itemId: string): string {
    return `${agentThreadId}:${itemId}`
  }
}

function findDoubleNewlineBoundary(text: string): number {
  const windows = text.indexOf('\r\n\r\n')
  const unix = text.indexOf('\n\n')
  const candidates = [windows, unix].filter((index) => index >= 0)
  if (candidates.length === 0) {
    return -1
  }
  return Math.min(...candidates)
}
