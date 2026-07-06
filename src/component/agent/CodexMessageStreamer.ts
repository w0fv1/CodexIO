import { inject, injectable } from 'inversify'
import { AppEvent, ChannelMessageDisplayRequestedEvent } from '../../value/Event.js'
import { Result } from '../../value/Result.js'
import { EventBus } from '../EventBus.js'
import { Logger } from '../Logger.js'

export type CodexStreamThread = {
  ioThreadId: string
  agentThreadId: string
  source?: ChannelMessageDisplayRequestedEvent['source']
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
  cancelled: boolean
}

@injectable()
export class CodexMessageStreamer {
  private readonly items = new Map<string, StreamItem>()
  private readonly completedItems = new Set<string>()

  constructor(
    @inject(EventBus) private readonly eventBus: EventBus
  ) {}

  async append(thread: CodexStreamThread, itemId: string, delta: string): Promise<void> {
    if (this.completedItems.has(this.completedKey(thread.ioThreadId, itemId))) {
      Logger.warn('codex stream delta ignored after item completed', {
        ioThreadId: thread.ioThreadId,
        itemId,
        length: delta.length
      })
      return
    }
    const item = this.getItem(thread, itemId)
    item.receivedDelta = true
    item.buffer += delta
    await this.flushCompletedSegments(item)
  }

  async complete(thread: CodexStreamThread, messages: CodexStreamMessage[]): Promise<void> {
    const activeThreadItems = [...this.items.values()].filter((item) => item.ioThreadId === thread.ioThreadId)
    const hasCompletedThreadItem = [...this.completedItems].some((key) => key.startsWith(`${thread.ioThreadId}\u0000`))
    if (messages.length > 0 && activeThreadItems.length === 0 && hasCompletedThreadItem) {
      this.clearCompletedThreadItems(thread.ioThreadId)
      return
    }
    const completedItemIds = new Set<string>()
    for (const message of messages) {
      const key = this.completedKey(thread.ioThreadId, message.itemId)
      if (this.completedItems.has(key)) {
        continue
      }
      const item = this.getCompletedItem(thread, message.itemId)
      if (!item.receivedDelta && item.buffer.length === 0) {
        item.buffer = message.text
      }
      await this.flushRemaining(item)
      completedItemIds.add(item.itemId)
      this.completedItems.add(key)
      this.items.delete(this.itemKey(item.agentThreadId, item.itemId))
    }
    for (const item of [...this.items.values()]) {
      if (item.ioThreadId === thread.ioThreadId && !completedItemIds.has(item.itemId)) {
        await this.flushRemaining(item)
        this.completedItems.add(this.completedKey(item.ioThreadId, item.itemId))
        this.items.delete(this.itemKey(item.agentThreadId, item.itemId))
      }
    }
    this.clearCompletedThreadItems(thread.ioThreadId)
  }

  async completeItem(thread: CodexStreamThread, itemId: string, text?: string): Promise<void> {
    const item = this.getCompletedItem(thread, itemId)
    if (!item.receivedDelta && item.buffer.length === 0 && text !== undefined) {
      item.buffer = text
    }
    await this.flushRemaining(item)
    this.completedItems.add(this.completedKey(item.ioThreadId, item.itemId))
    this.items.delete(this.itemKey(item.agentThreadId, item.itemId))
  }

  clearThread(ioThreadId: string): void {
    for (const [key, item] of this.items.entries()) {
      if (item.ioThreadId === ioThreadId) {
        item.cancelled = true
        this.items.delete(key)
      }
    }
    this.clearCompletedThreadItems(ioThreadId)
  }

  clear(): void {
    for (const item of this.items.values()) {
      item.cancelled = true
    }
    this.items.clear()
    this.completedItems.clear()
  }

  private getItem(thread: CodexStreamThread, itemId: string): StreamItem {
    const key = this.itemKey(thread.agentThreadId, itemId)
    const existing = this.items.get(key)
    if (existing) {
      return existing
    }
    const item: StreamItem = {
      ...thread,
      itemId,
      buffer: '',
      sending: Promise.resolve(),
      receivedDelta: false,
      cancelled: false
    }
    this.items.set(key, item)
    return item
  }

  private async flushCompletedSegments(item: StreamItem): Promise<void> {
    let boundary = findSentenceSegmentBoundary(item.buffer)
    while (boundary > 0) {
      const segment = item.buffer.slice(0, boundary)
      item.buffer = item.buffer.slice(boundary).trimStart()
      await this.queueSend(item, segment)
      boundary = findSentenceSegmentBoundary(item.buffer)
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
    if ('cancelled' in thread && thread.cancelled) {
      return
    }
    const segment = text.trim()
    if (segment.length === 0) {
      return
    }
    const results = await this.eventBus.emitAsync(AppEvent.ChannelMessageDisplayRequested, {
      source: thread.source,
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

  private itemKey(agentThreadId: string, itemId: string): string {
    return `${agentThreadId}:${itemId}`
  }

  private getCompletedItem(thread: CodexStreamThread, itemId: string): StreamItem {
    const existing = this.items.get(this.itemKey(thread.agentThreadId, itemId))
    if (existing) {
      return existing
    }
    const threadItems = [...this.items.values()].filter((item) => item.ioThreadId === thread.ioThreadId)
    if (threadItems.length === 1) {
      return threadItems[0]
    }
    return this.getItem(thread, itemId)
  }

  private completedKey(ioThreadId: string, itemId: string): string {
    return `${ioThreadId}\u0000${itemId}`
  }

  private clearCompletedThreadItems(ioThreadId: string): void {
    for (const key of [...this.completedItems]) {
      if (key.startsWith(`${ioThreadId}\u0000`)) {
        this.completedItems.delete(key)
      }
    }
  }
}

function findSentenceSegmentBoundary(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (!isDoubleNewlineAt(text, index)) {
      continue
    }
    if (endsWithSentencePunctuation(text.slice(0, index))) {
      return index
    }
  }
  return 0
}

function isDoubleNewlineAt(text: string, index: number): boolean {
  return text.startsWith('\n\n', index) || text.startsWith('\r\n\r\n', index)
}

function endsWithSentencePunctuation(text: string): boolean {
  return /[。！？.!?][”’"'）)\]}]*\s*$/.test(text)
}
