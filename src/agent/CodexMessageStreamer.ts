import { inject, injectable } from 'inversify'
import { ChannelOutputManager } from '../channel/ChannelOutputManager.js'
import { Logger } from '../component/Logger.js'

export type CodexMessageStreamThread = {
  ioThreadId: string
  agentThreadId: string
}

type StreamItem = {
  ioThreadId: string
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
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager
  ) {}

  async append(thread: CodexMessageStreamThread, itemId: string, delta: string): Promise<void> {
    if (this.completedItems.has(streamItemKey(thread.ioThreadId, itemId))) {
      Logger.warn('codex stream delta ignored after item completed', {
        ioThreadId: thread.ioThreadId,
        itemId,
        length: delta.length
      })
      return
    }
    const item = this.resolveItem(thread.ioThreadId, itemId)
    item.buffer += delta
    item.receivedDelta = true
    Logger.info('codex stream delta received', {
      ioThreadId: thread.ioThreadId,
      itemId,
      length: delta.length,
      buffered: item.buffer.length
    })
    await this.flushCompletedSegments(item)
  }

  async complete(thread: CodexMessageStreamThread, messages: Array<{ itemId: string, text: string }>): Promise<void> {
    const activeThreadItems = [...this.items.values()].filter((item) => item.ioThreadId === thread.ioThreadId)
    const hasCompletedThreadItem = [...this.completedItems].some((key) => key.startsWith(`${thread.ioThreadId}\u0000`))
    if (messages.length > 0 && activeThreadItems.length === 0 && hasCompletedThreadItem) {
      Logger.info('codex turn completed messages skipped', {
        ioThreadId: thread.ioThreadId,
        messages: messages.length
      })
      this.clearCompletedThreadItems(thread.ioThreadId)
      return
    }
    const completedItemIds = new Set<string>()
    for (const message of messages) {
      if (this.completedItems.has(streamItemKey(thread.ioThreadId, message.itemId))) {
        continue
      }
      const item = this.resolveCompletedItem(thread.ioThreadId, message.itemId)
      if (!item.receivedDelta && item.buffer.length === 0) {
        item.buffer = message.text
      }
      Logger.info('codex stream item completed', {
        ioThreadId: item.ioThreadId,
        itemId: item.itemId,
        streamed: item.receivedDelta,
        buffered: item.buffer.length,
        completedLength: message.text.length
      })
      await this.flushRemaining(item)
      completedItemIds.add(item.itemId)
      this.completedItems.add(streamItemKey(item.ioThreadId, item.itemId))
      this.items.delete(streamItemKey(item.ioThreadId, item.itemId))
    }
    for (const item of [...this.items.values()]) {
      if (item.ioThreadId === thread.ioThreadId && !completedItemIds.has(item.itemId)) {
        await this.flushRemaining(item)
        this.completedItems.add(streamItemKey(item.ioThreadId, item.itemId))
        this.items.delete(streamItemKey(item.ioThreadId, item.itemId))
      }
    }
    this.clearCompletedThreadItems(thread.ioThreadId)
  }

  async completeItem(thread: CodexMessageStreamThread, itemId: string): Promise<void> {
    const item = this.items.get(streamItemKey(thread.ioThreadId, itemId))
    if (!item) {
      return
    }
    Logger.info('codex stream item completed', {
      ioThreadId: item.ioThreadId,
      itemId: item.itemId,
      streamed: item.receivedDelta,
      buffered: item.buffer.length,
      completedLength: null
    })
    await this.flushRemaining(item)
    this.completedItems.add(streamItemKey(item.ioThreadId, item.itemId))
    this.items.delete(streamItemKey(item.ioThreadId, item.itemId))
  }

  clearThread(ioThreadId: string): void {
    for (const item of [...this.items.values()]) {
      if (item.ioThreadId === ioThreadId) {
        item.cancelled = true
        this.items.delete(streamItemKey(item.ioThreadId, item.itemId))
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

  private resolveItem(ioThreadId: string, itemId: string): StreamItem {
    const key = streamItemKey(ioThreadId, itemId)
    const existing = this.items.get(key)
    if (existing) {
      return existing
    }
    const item: StreamItem = {
      ioThreadId,
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
    let queued = false
    for (;;) {
      const boundary = findDoubleNewlineBoundary(item.buffer)
      if (boundary === 0) {
        if (queued) {
          await item.sending
        }
        return
      }
      const segment = item.buffer.slice(0, boundary)
      item.buffer = item.buffer.slice(boundary)
      this.enqueueSend(item, segment)
      queued = true
    }
  }

  private async flushRemaining(item: StreamItem): Promise<void> {
    await this.flushCompletedSegments(item)
    const segment = item.buffer
    item.buffer = ''
    this.enqueueSend(item, segment)
    await item.sending
  }

  private enqueueSend(item: StreamItem, segment: string): void {
    if (segment.trim().length > 0) {
      Logger.info('codex stream segment queued', {
        ioThreadId: item.ioThreadId,
        itemId: item.itemId,
        length: segment.trim().length,
        buffered: item.buffer.length
      })
    }
    item.sending = item.sending.then(() => this.sendSegment(item, segment), (error) => {
      Logger.error('codex streaming message queue failed', error)
      return this.sendSegment(item, segment)
    })
  }

  private async sendSegment(item: StreamItem, segment: string): Promise<void> {
    if (item.cancelled || segment.trim().length === 0) {
      return
    }
    const sent = await this.outputManager.sendAgent({
      ioThreadId: item.ioThreadId,
      role: 'agent',
      text: segment.trim(),
      createdAt: Date.now()
    })
    if (sent.isFailed) {
      Logger.warn('codex streaming message send failed', {
        message: sent.message
      })
      return
    }
    Logger.info('codex stream segment sent', {
      ioThreadId: item.ioThreadId,
      itemId: item.itemId,
      length: segment.trim().length
    })
  }

  private resolveCompletedItem(ioThreadId: string, itemId: string): StreamItem {
    const existing = this.items.get(streamItemKey(ioThreadId, itemId))
    if (existing) {
      return existing
    }
    const threadItems = [...this.items.values()].filter((item) => item.ioThreadId === ioThreadId)
    if (threadItems.length === 1) {
      return threadItems[0]
    }
    return this.resolveItem(ioThreadId, itemId)
  }

  private clearCompletedThreadItems(ioThreadId: string): void {
    for (const key of [...this.completedItems]) {
      if (key.startsWith(`${ioThreadId}\u0000`)) {
        this.completedItems.delete(key)
      }
    }
  }

}

function streamItemKey(ioThreadId: string, itemId: string): string {
  return `${ioThreadId}\u0000${itemId}`
}

function findDoubleNewlineBoundary(text: string): number {
  const index = text.indexOf('\n\n')
  return index < 0 ? 0 : index + 2
}
